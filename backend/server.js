require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { applyRate, withDisplayAmounts } = require('./money');
const {
  chatRequestSchema,
  orderIdParamsSchema,
  orderStatusBodySchema,
  cancelOrderBodySchema,
  loginBodySchema,
  validate,
} = require('./validation');
const { createAuditLog } = require('./audit');
const { createOrderStore } = require('./orders');
const { createStaffStore } = require('./staff');
const { createSessionStore } = require('./sessions');
const { permissionsFor } = require('./permissions');

const app = express();
const PORT = process.env.PORT || 3000;

// Flat rates — single configured number each, no per-item or per-jurisdiction rules.
const TAX_RATE_BASIS_POINTS = 800;
const DELIVERY_FEE_CENTS = 300;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BASE_SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'system-prompt.md'),
  'utf-8'
);
const MENU = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'menu.json'), 'utf-8')
);
const PROMOTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'promotions.json'), 'utf-8')
);
const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n## Menu Data\n\nThis is the complete, authoritative menu. Only reference items, prices, sizes, options, and allergens listed here — never invent or assume any that aren't present.\n\n${JSON.stringify(withDisplayAmounts(MENU), null, 2)}`;

// In-memory only — no database. State resets on server restart.
const orderSessions = new Map();

function createOrderState() {
  return {
    items: [],
    orderType: null,
    customer: { name: null, phone: null, email: null },
    pickupTime: null,
    delivery: { address: null, apartmentUnit: null, instructions: null, addressConfirmed: false },
    discount: null,
    totalCents: 0,
    confirmed: false,
    status: 'pending',
    suggestedItemIds: [],
  };
}

function getOrderState(sessionId) {
  if (!orderSessions.has(sessionId)) {
    orderSessions.set(sessionId, createOrderState());
  }
  return orderSessions.get(sessionId);
}

const TOOLS = [
  {
    name: 'getMenu',
    description: 'Get the current café menu, including only items that are currently available for order.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'addItemToCart',
    description: 'Add a menu item to the customer\'s order. Only call this after the customer has confirmed the item and, if it has more than one size, which size they want. If the item requires a size and none is given, this returns an error listing the valid sizes instead of adding anything — ask the customer and call again, never guess a size or option.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The id of the menu item, from the menu data.' },
        size: { type: 'string', description: 'The chosen size. Must match one of the item\'s valid sizes.' },
        quantity: { type: 'integer', description: 'How many of this item to add. Defaults to 1.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Any chosen add-ons/options. Must match the item\'s valid options.',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'modifyItem',
    description: 'Change the quantity, size, and/or options of an item already in the customer\'s order. Identify the line with itemId, plus currentSize and/or currentOptions if the customer has more than one line for that item. If more than one line still matches, this returns those matches instead of guessing — ask the customer which one they mean and call again. Only include the fields that are actually changing.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The id of the menu item to modify, matching a line already in the order.' },
        currentSize: { type: 'string', description: 'The line\'s current size, used to disambiguate when multiple lines share the same itemId.' },
        currentOptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'The line\'s current options, used to disambiguate when multiple lines share the same itemId and size.',
        },
        quantity: { type: 'integer', description: 'The new quantity, if changing.' },
        size: { type: 'string', description: 'The new size, if changing. Must match one of the item\'s valid sizes.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'The new full list of options, if changing. Replaces the existing options entirely and must match the item\'s valid options.',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'removeItem',
    description: 'Remove an item from the customer\'s order, or reduce its quantity. Identify the line with itemId, plus currentSize and/or currentOptions if the customer has more than one line for that item. If more than one line still matches, this returns those matches instead of guessing — ask the customer which one they mean and call again. Omit quantity to remove the line entirely; otherwise that many are removed, and the line is dropped entirely if quantity reaches zero.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The id of the menu item to remove, matching a line already in the order.' },
        currentSize: { type: 'string', description: 'The line\'s current size, used to disambiguate when multiple lines share the same itemId.' },
        currentOptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'The line\'s current options, used to disambiguate when multiple lines share the same itemId and size.',
        },
        quantity: { type: 'integer', description: 'How many to remove. Omit to remove the entire line.' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'viewCart',
    description: 'Get a concise itemized summary of everything currently in the customer\'s order — items, quantities, sizes, and options. Does not include pricing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'getRecommendations',
    description: 'Get up to 1-2 real menu items that pair well with what\'s currently in the order (e.g. a bakery item for a drink-only order, or a drink for a food-only order). Call this at most once after items are added, when there\'s a natural pairing gap. Only ever mention items this tool returns — never invent or suggest a menu item yourself. Each item is only ever returned once per session, so if the customer declines, do not bring it up again.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'setPickupDetails',
    description: 'Select pickup and record the customer\'s pickup details. Name is required before checkout; pickup time is optional (the customer can leave it for "as soon as possible"). Call with just whatever field the customer just gave you — omit the rest. The response always reports which required fields are still missing; ask the customer only about those, never re-ask for something already recorded. Call with no arguments to check current status before asking anything.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The customer\'s name for the pickup order.' },
        pickupTime: { type: 'string', description: 'The requested pickup time, in whatever form the customer gave it (e.g. "5:30pm", "in 20 minutes", "asap"). Optional.' },
      },
    },
  },
  {
    name: 'setDeliveryDetails',
    description: 'Select delivery and record the customer\'s delivery details. Name, phone number, and full delivery address are required before checkout; apartment/unit and delivery instructions are optional. Call with just whatever field the customer just gave you — omit the rest, and never guess or fill in a field the customer hasn\'t actually given you. The response always reports which required fields are still missing; ask the customer only about those, never re-ask for something already recorded. Call with no arguments to check current status before asking anything.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The customer\'s name for the delivery order.' },
        phone: { type: 'string', description: 'A phone number to reach the customer for delivery.' },
        address: { type: 'string', description: 'The full delivery address (street, city, etc).' },
        apartmentUnit: { type: 'string', description: 'Apartment, suite, or unit number, if applicable. Optional.' },
        instructions: { type: 'string', description: 'Delivery instructions (e.g. gate code, leave at door). Optional.' },
      },
    },
  },
  {
    name: 'confirmDeliveryAddress',
    description: 'Record the customer\'s explicit confirmation or correction of their delivery address. Only call this after you have read the full current address (street address plus apartment/unit, if any) back to the customer verbatim and they\'ve responded. Pass confirmed: true only if they explicitly confirmed it is correct; pass confirmed: false if they said it\'s wrong or want to change it — in that case call setDeliveryDetails with the correction, then read the corrected address back and confirm again. This must be confirmed before a delivery order can be finalized.',
    input_schema: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'true if the customer explicitly confirmed the address is correct, false if they said it needs correction.' },
      },
      required: ['confirmed'],
    },
  },
  {
    name: 'getOrderSummary',
    description: 'Get the complete, structured order summary — items with quantities and customizations, fulfillment details (pickup or delivery), any currently eligible or applied promotions, and the authoritative total. Call this before presenting the final order for checkout confirmation, and read its data back to the customer rather than assembling or calculating the summary yourself. Its "issues" field lists anything still required before checkout (e.g. missing fulfillment details, an unconfirmed delivery address) — resolve those first.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'finalizeOrder',
    description: 'Finalize and save the order — this is the only way an order is ever saved. Call getOrderSummary first and read the full summary back to the customer verbatim, then call this only after they respond with an explicit, unambiguous "yes" to that exact summary. Pass confirmed: true only for that unambiguous affirmative; for anything else — hesitation, a question, a change request, silence, or any other ambiguous reply — do not call this with confirmed: true, ask a direct yes/no question instead. This refuses to finalize if the order isn\'t ready for checkout (see getOrderSummary\'s issues) or if confirmed isn\'t true, and it cannot be called twice. Once finalized, the order is locked and no other order tool can modify it.',
    input_schema: {
      type: 'object',
      properties: {
        confirmed: { type: 'boolean', description: 'true only if the customer just gave an explicit, unambiguous yes to the exact summary from getOrderSummary.' },
      },
      required: ['confirmed'],
    },
  },
  {
    name: 'getOrderTotal',
    description: 'Get the authoritative, deterministically-calculated order total — subtotal from real menu prices and quantities, any applied promotion\'s discount, tax, and (for delivery orders) the delivery fee. This is the only source of truth for prices and totals — never calculate, estimate, or state a total yourself. Call this whenever you need to tell the customer the total, including right before final checkout confirmation.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'applyPromotion',
    description: 'Check and apply real, active promotions against the customer\'s current order. Call with no promotionId to see which active promotions the current order actually qualifies for right now — use this to recommend a promotion, never invent one. Call with a promotionId (from this data, or one the customer names) to apply it; if it isn\'t a real active promotion or the order doesn\'t meet its eligibility rules, this returns an error instead of applying anything — never tell the customer a discount was applied unless this tool reports success. Never accept or reference a promo code that isn\'t in this data.',
    input_schema: {
      type: 'object',
      properties: {
        promotionId: { type: 'string', description: 'The id of the promotion to apply, from the promotions data. Omit to instead list promotions the order currently qualifies for.' },
      },
    },
  },
];

function sumLineTotalsCents(lines) {
  return lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
}

function getMenu() {
  return MENU.filter((item) => item.available);
}

function addItemToCart(order, input) {
  if (order.confirmed) {
    return { error: 'order_already_finalized' };
  }

  const { itemId, size, quantity, options } = input || {};

  const item = MENU.find((m) => m.id === itemId && m.available);
  if (!item) {
    return { error: 'item_not_found' };
  }

  if (item.sizes.length > 1 && !size) {
    return { error: 'size_required', validSizes: item.sizes };
  }

  const resolvedSize = size || item.sizes[0];
  if (!item.sizes.includes(resolvedSize)) {
    return { error: 'invalid_size', validSizes: item.sizes };
  }

  const chosenOptions = Array.isArray(options) ? options : [];
  const invalidOptions = chosenOptions.filter((o) => !item.options.includes(o));
  if (invalidOptions.length > 0) {
    return { error: 'invalid_options', invalidOptions, validOptions: item.options };
  }

  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const lineTotalCents = item.priceCents * qty;

  order.items.push({
    itemId: item.id,
    name: item.name,
    size: resolvedSize,
    quantity: qty,
    options: chosenOptions,
    unitPriceCents: item.priceCents,
    lineTotalCents,
  });
  order.discount = null;
  order.totalCents = sumLineTotalsCents(order.items);

  return { success: true, addedItem: order.items[order.items.length - 1], order };
}

function findOrderLines(order, { itemId, currentSize, currentOptions }) {
  const normalize = (opts) => [...(opts || [])].map(String).sort().join('|');
  return order.items.filter((line) => {
    if (line.itemId !== itemId) return false;
    if (currentSize !== undefined && line.size !== currentSize) return false;
    if (currentOptions !== undefined && normalize(line.options) !== normalize(currentOptions)) return false;
    return true;
  });
}

function modifyItem(order, input) {
  if (order.confirmed) {
    return { error: 'order_already_finalized' };
  }

  const { itemId, currentSize, currentOptions, quantity, size, options } = input || {};

  if (quantity === undefined && size === undefined && options === undefined) {
    return { error: 'no_changes_specified' };
  }

  const matches = findOrderLines(order, { itemId, currentSize, currentOptions });
  if (matches.length === 0) {
    return { error: 'item_not_found_in_order' };
  }
  if (matches.length > 1) {
    return {
      error: 'ambiguous_item',
      matches: matches.map((m) => ({ size: m.size, options: m.options, quantity: m.quantity })),
    };
  }

  const target = matches[0];
  const menuItem = MENU.find((m) => m.id === itemId);

  if (size !== undefined) {
    if (!menuItem.sizes.includes(size)) {
      return { error: 'invalid_size', validSizes: menuItem.sizes };
    }
    target.size = size;
  }

  if (options !== undefined) {
    const chosenOptions = Array.isArray(options) ? options : [];
    const invalidOptions = chosenOptions.filter((o) => !menuItem.options.includes(o));
    if (invalidOptions.length > 0) {
      return { error: 'invalid_options', invalidOptions, validOptions: menuItem.options };
    }
    target.options = chosenOptions;
  }

  if (quantity !== undefined) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { error: 'invalid_quantity' };
    }
    target.quantity = quantity;
  }

  target.lineTotalCents = target.unitPriceCents * target.quantity;
  order.discount = null;
  order.totalCents = sumLineTotalsCents(order.items);

  return { success: true, updatedItem: target, order };
}

function removeItem(order, input) {
  if (order.confirmed) {
    return { error: 'order_already_finalized' };
  }

  const { itemId, currentSize, currentOptions, quantity } = input || {};

  const matches = findOrderLines(order, { itemId, currentSize, currentOptions });
  if (matches.length === 0) {
    return { error: 'item_not_found_in_order' };
  }
  if (matches.length > 1) {
    return {
      error: 'ambiguous_item',
      matches: matches.map((m) => ({ size: m.size, options: m.options, quantity: m.quantity })),
    };
  }

  const target = matches[0];

  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
    return { error: 'invalid_quantity' };
  }

  const removeQty = quantity === undefined ? target.quantity : quantity;

  if (removeQty >= target.quantity) {
    order.items = order.items.filter((line) => line !== target);
  } else {
    target.quantity -= removeQty;
    target.lineTotalCents = target.unitPriceCents * target.quantity;
  }

  order.discount = null;
  order.totalCents = sumLineTotalsCents(order.items);

  return { success: true, removedQuantity: removeQty, order };
}

function viewCart(order) {
  return {
    items: order.items.map((line) => ({
      item: line.name,
      quantity: line.quantity,
      size: line.size,
      options: line.options,
    })),
  };
}

function getRecommendations(order) {
  if (order.items.length === 0) {
    return { recommendations: [] };
  }

  const inCartIds = new Set(order.items.map((line) => line.itemId));
  const categoriesInCart = new Set(
    order.items.map((line) => MENU.find((m) => m.id === line.itemId)?.category)
  );
  const hasDrink = categoriesInCart.has('coffee') || categoriesInCart.has('tea');
  const hasFood = categoriesInCart.has('bakery') || categoriesInCart.has('food');

  let targetCategories;
  if (hasDrink && !hasFood) {
    targetCategories = ['bakery', 'food'];
  } else if (hasFood && !hasDrink) {
    targetCategories = ['coffee', 'tea'];
  } else {
    return { recommendations: [] };
  }

  const candidates = MENU.filter(
    (item) =>
      item.available &&
      targetCategories.includes(item.category) &&
      !inCartIds.has(item.id) &&
      !order.suggestedItemIds.includes(item.id)
  );

  const picks = candidates.slice(0, 2);
  picks.forEach((item) => order.suggestedItemIds.push(item.id));

  return {
    recommendations: picks.map((item) => ({
      itemId: item.id,
      name: item.name,
      description: item.description,
      priceCents: item.priceCents,
    })),
  };
}

function setPickupDetails(order, input) {
  if (order.confirmed) {
    return { error: 'order_already_finalized' };
  }

  const { name, pickupTime } = input || {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return { error: 'invalid_name' };
    }
    order.customer.name = name.trim();
  }

  if (pickupTime !== undefined) {
    if (typeof pickupTime !== 'string' || !pickupTime.trim()) {
      return { error: 'invalid_pickup_time' };
    }
    order.pickupTime = pickupTime.trim();
  }

  order.orderType = 'pickup';

  const missingFields = [];
  if (!order.customer.name) missingFields.push('name');

  return {
    success: true,
    pickupDetails: { name: order.customer.name, pickupTime: order.pickupTime },
    missingFields,
  };
}

function setDeliveryDetails(order, input) {
  if (order.confirmed) {
    return { error: 'order_already_finalized' };
  }

  const { name, phone, address, apartmentUnit, instructions } = input || {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return { error: 'invalid_name' };
    order.customer.name = name.trim();
  }
  if (phone !== undefined) {
    if (typeof phone !== 'string' || !phone.trim()) return { error: 'invalid_phone' };
    order.customer.phone = phone.trim();
  }
  if (address !== undefined) {
    if (typeof address !== 'string' || !address.trim()) return { error: 'invalid_address' };
    order.delivery.address = address.trim();
    order.delivery.addressConfirmed = false;
  }
  if (apartmentUnit !== undefined) {
    if (typeof apartmentUnit !== 'string' || !apartmentUnit.trim()) return { error: 'invalid_apartment_unit' };
    order.delivery.apartmentUnit = apartmentUnit.trim();
    order.delivery.addressConfirmed = false;
  }
  if (instructions !== undefined) {
    if (typeof instructions !== 'string' || !instructions.trim()) return { error: 'invalid_instructions' };
    order.delivery.instructions = instructions.trim();
  }

  order.orderType = 'delivery';

  const missingFields = [];
  if (!order.customer.name) missingFields.push('name');
  if (!order.customer.phone) missingFields.push('phone');
  if (!order.delivery.address) missingFields.push('address');

  return {
    success: true,
    deliveryDetails: {
      name: order.customer.name,
      phone: order.customer.phone,
      address: order.delivery.address,
      apartmentUnit: order.delivery.apartmentUnit,
      instructions: order.delivery.instructions,
      addressConfirmed: order.delivery.addressConfirmed,
    },
    missingFields,
  };
}

function confirmDeliveryAddress(order, input) {
  if (order.confirmed) {
    return { error: 'order_already_finalized' };
  }

  const { confirmed } = input || {};

  if (order.orderType !== 'delivery') {
    return { error: 'not_a_delivery_order' };
  }
  if (!order.delivery.address) {
    return { error: 'address_not_set' };
  }
  if (typeof confirmed !== 'boolean') {
    return { error: 'confirmed_required' };
  }

  order.delivery.addressConfirmed = confirmed;

  return {
    success: true,
    deliveryDetails: {
      name: order.customer.name,
      phone: order.customer.phone,
      address: order.delivery.address,
      apartmentUnit: order.delivery.apartmentUnit,
      instructions: order.delivery.instructions,
      addressConfirmed: order.delivery.addressConfirmed,
    },
  };
}

function getOrderTotal(order) {
  const subtotalCents = sumLineTotalsCents(order.items);
  const discountCents = order.discount ? order.discount.amountCents : 0;
  const discountedSubtotalCents = subtotalCents - discountCents;
  const taxCents = applyRate(discountedSubtotalCents, TAX_RATE_BASIS_POINTS);
  const deliveryFeeCents = order.orderType === 'delivery' ? DELIVERY_FEE_CENTS : 0;
  const totalCents = discountedSubtotalCents + taxCents + deliveryFeeCents;

  return {
    subtotalCents,
    discount: order.discount ? { promotionId: order.discount.promotionId, name: order.discount.name, amountCents: discountCents } : null,
    taxCents,
    deliveryFeeCents,
    totalCents,
  };
}

function isWithinTimeWindow(timeWindow) {
  const now = new Date();
  const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return current >= timeWindow.start && current < timeWindow.end;
}

function calculateDiscountCents(promo, qualifyingLines) {
  if (promo.discountType === 'percentage') {
    return applyRate(sumLineTotalsCents(qualifyingLines), promo.discountPercent * 100);
  }
  return qualifyingLines.reduce((sum, line) => sum + Math.min(promo.discountCents, line.lineTotalCents), 0);
}

function evaluatePromotion(promo, order) {
  const elig = promo.eligibility;

  const qualifyingLines = order.items.filter((line) => {
    const item = MENU.find((m) => m.id === line.itemId);
    if (!item) return false;
    if (elig.items && !elig.items.includes(item.id)) return false;
    if (elig.categories && !elig.categories.includes(item.category)) return false;
    return true;
  });
  if (qualifyingLines.length === 0) {
    return { eligible: false, reason: 'no_qualifying_items' };
  }

  if (elig.requiresItemFromCategories) {
    const hasRequired = order.items.some((line) => {
      const item = MENU.find((m) => m.id === line.itemId);
      return item && elig.requiresItemFromCategories.includes(item.category);
    });
    if (!hasRequired) {
      return { eligible: false, reason: 'missing_required_item' };
    }
  }

  if (elig.minSpendCents != null && order.totalCents < elig.minSpendCents) {
    return { eligible: false, reason: 'below_min_spend' };
  }

  if (elig.timeWindow && !isWithinTimeWindow(elig.timeWindow)) {
    return { eligible: false, reason: 'outside_time_window' };
  }

  return { eligible: true, amountCents: calculateDiscountCents(promo, qualifyingLines) };
}

function applyPromotion(order, input) {
  if (order.confirmed) {
    return { error: 'order_already_finalized' };
  }

  const { promotionId } = input || {};

  if (!promotionId) {
    const eligiblePromotions = PROMOTIONS.filter((p) => p.active)
      .map((promo) => ({ promo, result: evaluatePromotion(promo, order) }))
      .filter(({ result }) => result.eligible)
      .map(({ promo, result }) => ({
        promotionId: promo.id,
        name: promo.name,
        rule: promo.rule,
        estimatedDiscountCents: result.amountCents,
      }));

    return { eligiblePromotions };
  }

  const promo = PROMOTIONS.find((p) => p.id === promotionId && p.active);
  if (!promo) {
    return { error: 'promotion_not_found' };
  }

  const result = evaluatePromotion(promo, order);
  if (!result.eligible) {
    return { error: 'not_eligible', reason: result.reason };
  }

  order.discount = { promotionId: promo.id, name: promo.name, amountCents: result.amountCents };
  order.totalCents = sumLineTotalsCents(order.items) - result.amountCents;

  return { success: true, appliedPromotion: order.discount, order };
}

function getOrderSummary(order) {
  const items = order.items.map((line) => ({
    item: line.name,
    quantity: line.quantity,
    size: line.size,
    options: line.options,
    unitPriceCents: line.unitPriceCents,
    lineTotalCents: line.lineTotalCents,
  }));

  const fulfillment = { type: order.orderType };
  if (order.orderType === 'pickup') {
    fulfillment.pickup = { name: order.customer.name, pickupTime: order.pickupTime };
  } else if (order.orderType === 'delivery') {
    fulfillment.delivery = {
      name: order.customer.name,
      phone: order.customer.phone,
      address: order.delivery.address,
      apartmentUnit: order.delivery.apartmentUnit,
      instructions: order.delivery.instructions,
      addressConfirmed: order.delivery.addressConfirmed,
    };
  }

  const promotions = PROMOTIONS.filter((p) => p.active)
    .map((promo) => ({ promo, result: evaluatePromotion(promo, order) }))
    .filter(({ result }) => result.eligible)
    .map(({ promo, result }) => ({
      promotionId: promo.id,
      name: promo.name,
      rule: promo.rule,
      estimatedDiscountCents: result.amountCents,
      applied: order.discount ? order.discount.promotionId === promo.id : false,
    }));

  const issues = [];
  if (order.items.length === 0) issues.push('cart_empty');
  if (!order.orderType) issues.push('fulfillment_not_selected');
  if (order.orderType === 'pickup' && !order.customer.name) issues.push('pickup_name_missing');
  if (order.orderType === 'delivery') {
    if (!order.customer.name) issues.push('delivery_name_missing');
    if (!order.customer.phone) issues.push('delivery_phone_missing');
    if (!order.delivery.address) issues.push('delivery_address_missing');
    if (order.delivery.address && !order.delivery.addressConfirmed) issues.push('delivery_address_not_confirmed');
  }

  return {
    items,
    fulfillment,
    promotions,
    totals: getOrderTotal(order),
    readyForCheckout: issues.length === 0,
    issues,
  };
}

function finalizeOrder(order, input, sessionId) {
  if (order.confirmed) {
    return { error: 'order_already_finalized' };
  }

  const { confirmed } = input || {};

  const summary = getOrderSummary(order);
  if (!summary.readyForCheckout) {
    return { error: 'not_ready', issues: summary.issues };
  }

  if (confirmed !== true) {
    return { error: 'confirmation_required' };
  }

  const savedOrder = {
    id: crypto.randomUUID(),
    confirmedAt: new Date().toISOString(),
    status: 'NEW',
    items: summary.items,
    fulfillment: summary.fulfillment,
    promotions: summary.promotions.filter((p) => p.applied),
    totals: summary.totals,
  };

  try {
    orderStore.create(savedOrder, sessionId);
  } catch (err) {
    console.error('Failed to save order:', err);
    return { error: 'save_failed' };
  }

  order.confirmed = true;
  order.status = 'confirmed';

  return { success: true, order: savedOrder };
}

function runTool(block, order, sessionId) {
  switch (block.name) {
    case 'getMenu':
      return getMenu();
    case 'addItemToCart':
      return addItemToCart(order, block.input);
    case 'modifyItem':
      return modifyItem(order, block.input);
    case 'removeItem':
      return removeItem(order, block.input);
    case 'viewCart':
      return viewCart(order);
    case 'getRecommendations':
      return getRecommendations(order);
    case 'setPickupDetails':
      return setPickupDetails(order, block.input);
    case 'setDeliveryDetails':
      return setDeliveryDetails(order, block.input);
    case 'confirmDeliveryAddress':
      return confirmDeliveryAddress(order, block.input);
    case 'getOrderSummary':
      return getOrderSummary(order);
    case 'finalizeOrder':
      return finalizeOrder(order, block.input, sessionId);
    case 'getOrderTotal':
      return getOrderTotal(order);
    case 'applyPromotion':
      return applyPromotion(order, block.input);
    default:
      throw new Error(`Unknown tool: ${block.name}`);
  }
}

app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { data, error } = validate(chatRequestSchema, req.body);
  if (error) {
    return res.status(400).json(error);
  }
  const { message, conversationHistory } = data;
  const sessionId = data.sessionId || crypto.randomUUID();

  const order = getOrderState(sessionId);

  try {
    const messages = [...conversationHistory, { role: 'user', content: message }];

    let response = await anthropic.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    while (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = response.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(withDisplayAmounts(runTool(block, order, sessionId))),
        }));

      messages.push({ role: 'user', content: toolResults });

      response = await anthropic.messages.create({
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    }

    const replyText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    res.json({
      sessionId,
      reply: replyText,
      conversationHistory: [
        ...conversationHistory,
        { role: 'user', content: message },
        { role: 'assistant', content: replyText },
      ],
      order,
    });
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({
      reply: "Sorry, I'm having trouble responding right now. Please try again in a moment.",
    });
  }
});

// Orders are persisted to data/orders.json for development/demo purposes only.
// Serverless platforms like Vercel run functions on ephemeral, read-only-by-default
// filesystems, so writes here are not guaranteed to persist in production — replace
// with a real database before deploying there.
const auditLog = createAuditLog(path.join(__dirname, '..', 'data', 'audit-log.jsonl'));
const orderStore = createOrderStore(path.join(__dirname, '..', 'data', 'orders.json'), auditLog);
const staffStore = createStaffStore(path.join(__dirname, '..', 'data', 'staff.json'));

const SESSION_COOKIE = 'staff_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessionStore = createSessionStore({ ttlMs: SESSION_TTL_MS });

function readSessionToken(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value;
  }
  return null;
}

app.post('/api/staff/login', (req, res) => {
  const { data, error } = validate(loginBodySchema, req.body);
  if (error) {
    return res.status(400).json(error);
  }

  const member = staffStore.verify(data.username, data.password);
  if (!member) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  auditLog.append({
    actorType: 'STAFF',
    actorId: member.username,
    action: 'LOGIN',
    entityType: 'STAFF',
    entityId: member.username,
    before: null,
    after: null,
    reason: null,
  });
  res.cookie(SESSION_COOKIE, sessionStore.create(member.username, member.role), {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ username: member.username, role: member.role });
});

app.post('/api/staff/logout', (req, res) => {
  sessionStore.destroy(readSessionToken(req));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
});

// Every /api/staff route registered after this point requires a signed-in staff member.
app.use('/api/staff', (req, res, next) => {
  const session = sessionStore.get(readSessionToken(req));
  if (!session) {
    return res.status(401).json({ error: 'not_signed_in' });
  }
  req.staff = session;
  next();
});

app.get('/api/staff/me', (req, res) => {
  const { username, role } = req.staff;
  res.json({ username, role, permissions: permissionsFor(role) });
});

app.get('/api/staff/orders', (req, res) => {
  const result = orderStore.list(req.staff);
  if (result.error) {
    return res.status(403).json(result);
  }
  res.json(result.orders);
});

app.get('/api/staff/orders/:id/history', (req, res) => {
  const params = validate(orderIdParamsSchema, req.params);
  if (params.error) {
    return res.status(400).json(params.error);
  }

  const result = orderStore.history(params.data.id, req.staff);
  if (result.error === 'forbidden') {
    return res.status(403).json(result);
  }
  if (result.error) {
    return res.status(404).json(result);
  }
  res.json(result.entries);
});

app.patch('/api/staff/orders/:id/status', (req, res) => {
  const params = validate(orderIdParamsSchema, req.params);
  if (params.error) {
    return res.status(400).json(params.error);
  }
  const body = validate(orderStatusBodySchema, req.body);
  if (body.error) {
    return res.status(400).json(body.error);
  }
  const { status } = body.data;

  const result = orderStore.updateStatus(params.data.id, status, req.staff);
  if (result.error === 'forbidden') {
    return res.status(403).json(result);
  }
  if (result.error === 'order_not_found') {
    return res.status(404).json(result);
  }
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json({ success: true, order: result.order });
});

app.post('/api/staff/orders/:id/cancel', (req, res) => {
  const params = validate(orderIdParamsSchema, req.params);
  if (params.error) {
    return res.status(400).json(params.error);
  }
  const body = validate(cancelOrderBodySchema, req.body);
  if (body.error) {
    return res.status(400).json(body.error);
  }

  const result = orderStore.cancel(params.data.id, body.data.reason, req.staff);
  if (result.error === 'forbidden') {
    return res.status(403).json(result);
  }
  if (result.error === 'order_not_found') {
    return res.status(404).json(result);
  }
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json({ success: true, order: result.order });
});

// Replaces Express's default error page, which exposes a stack trace (e.g. on
// malformed JSON bodies).
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) {
    console.error(err);
  }
  res.status(status).json({ error: status === 500 ? 'internal_error' : err.type || 'bad_request' });
});

app.listen(PORT, () => {
  console.log(`CafeBot server running on http://localhost:${PORT}`);
});

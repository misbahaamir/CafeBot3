require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Flat rates — single configured number each, no per-item or per-jurisdiction rules.
const TAX_RATE = 0.08;
const DELIVERY_FEE = 3.00;

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
const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n## Menu Data\n\nThis is the complete, authoritative menu. Only reference items, prices, sizes, options, and allergens listed here — never invent or assume any that aren't present.\n\n${JSON.stringify(MENU, null, 2)}`;

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
    total: 0,
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
  const lineTotal = Math.round(item.price * qty * 100) / 100;

  order.items.push({
    itemId: item.id,
    name: item.name,
    size: resolvedSize,
    quantity: qty,
    options: chosenOptions,
    unitPrice: item.price,
    lineTotal,
  });
  order.discount = null;
  order.total = Math.round(order.items.reduce((sum, i) => sum + i.lineTotal, 0) * 100) / 100;

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

  target.lineTotal = Math.round(target.unitPrice * target.quantity * 100) / 100;
  order.discount = null;
  order.total = Math.round(order.items.reduce((sum, i) => sum + i.lineTotal, 0) * 100) / 100;

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
    target.lineTotal = Math.round(target.unitPrice * target.quantity * 100) / 100;
  }

  order.discount = null;
  order.total = Math.round(order.items.reduce((sum, i) => sum + i.lineTotal, 0) * 100) / 100;

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
      price: item.price,
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
  const subtotal = Math.round(order.items.reduce((sum, i) => sum + i.lineTotal, 0) * 100) / 100;
  const discountAmount = order.discount ? order.discount.amount : 0;
  const discountedSubtotal = Math.round((subtotal - discountAmount) * 100) / 100;
  const tax = Math.round(discountedSubtotal * TAX_RATE * 100) / 100;
  const deliveryFee = order.orderType === 'delivery' ? DELIVERY_FEE : 0;
  const total = Math.round((discountedSubtotal + tax + deliveryFee) * 100) / 100;

  return {
    subtotal,
    discount: order.discount ? { promotionId: order.discount.promotionId, name: order.discount.name, amount: discountAmount } : null,
    tax,
    deliveryFee,
    total,
  };
}

function isWithinTimeWindow(timeWindow) {
  const now = new Date();
  const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return current >= timeWindow.start && current < timeWindow.end;
}

function calculateDiscountAmount(promo, qualifyingLines) {
  const amount = qualifyingLines.reduce((sum, line) => {
    if (promo.discountType === 'percentage') {
      return sum + line.lineTotal * (promo.discountValue / 100);
    }
    return sum + Math.min(promo.discountValue, line.lineTotal);
  }, 0);
  return Math.round(amount * 100) / 100;
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

  if (elig.minSpend != null && order.total < elig.minSpend) {
    return { eligible: false, reason: 'below_min_spend' };
  }

  if (elig.timeWindow && !isWithinTimeWindow(elig.timeWindow)) {
    return { eligible: false, reason: 'outside_time_window' };
  }

  return { eligible: true, amount: calculateDiscountAmount(promo, qualifyingLines) };
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
        estimatedDiscount: result.amount,
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

  order.discount = { promotionId: promo.id, name: promo.name, amount: result.amount };
  const subtotal = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
  order.total = Math.round((subtotal - result.amount) * 100) / 100;

  return { success: true, appliedPromotion: order.discount, order };
}

function getOrderSummary(order) {
  const items = order.items.map((line) => ({
    item: line.name,
    quantity: line.quantity,
    size: line.size,
    options: line.options,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
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
      estimatedDiscount: result.amount,
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

function finalizeOrder(order, input) {
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

  order.confirmed = true;
  order.status = 'confirmed';

  const savedOrder = {
    id: crypto.randomUUID(),
    confirmedAt: new Date().toISOString(),
    status: 'NEW',
    items: summary.items,
    fulfillment: summary.fulfillment,
    promotions: summary.promotions.filter((p) => p.applied),
    totals: summary.totals,
  };

  // data/orders.json is flat-file, dev-only storage — not a real database.
  const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
  const savedOrders = JSON.parse(fs.readFileSync(ordersPath, 'utf-8'));
  savedOrders.push(savedOrder);
  fs.writeFileSync(ordersPath, JSON.stringify(savedOrders, null, 2));

  return { success: true, order: savedOrder };
}

function runTool(block, order) {
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
      return finalizeOrder(order, block.input);
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
  const { message, conversationHistory } = req.body;
  const sessionId = req.body.sessionId || crypto.randomUUID();

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const order = getOrderState(sessionId);

  try {
    const messages = [...(conversationHistory || []), { role: 'user', content: message }];

    let response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
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
          content: JSON.stringify(runTool(block, order)),
        }));

      messages.push({ role: 'user', content: toolResults });

      response = await anthropic.messages.create({
        model: 'claude-sonnet-5',
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
        ...(conversationHistory || []),
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

const ORDER_STATUS_FLOW = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];
const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');

function readSavedOrders() {
  return JSON.parse(fs.readFileSync(ordersPath, 'utf-8'));
}

app.get('/api/staff/orders', (req, res) => {
  res.json(readSavedOrders());
});

app.patch('/api/staff/orders/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!ORDER_STATUS_FLOW.includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }

  const savedOrders = readSavedOrders();
  const order = savedOrders.find((o) => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'order_not_found' });
  }

  const currentIndex = ORDER_STATUS_FLOW.indexOf(order.status);
  const nextIndex = ORDER_STATUS_FLOW.indexOf(status);
  if (nextIndex !== currentIndex + 1) {
    return res.status(400).json({ error: 'invalid_transition' });
  }

  order.status = status;
  fs.writeFileSync(ordersPath, JSON.stringify(savedOrders, null, 2));
  res.json({ success: true, order });
});

app.listen(PORT, () => {
  console.log(`CafeBot server running on http://localhost:${PORT}`);
});

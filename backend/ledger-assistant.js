const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { can } = require('./permissions');
const { formatCents, parseDollarsToCents } = require('./money');
const { EXPENSE_CATEGORIES, CATEGORY_CODES } = require('./categories');
const { leaseCovers } = require('./rentals');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const MODEL = 'claude-sonnet-5-5';
const BASE_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'ledger-assistant.md'), 'utf-8');

const PAYMENT_METHODS = ['CASH', 'CHEQUE', 'CREDIT_CARD', 'DEBIT', 'E_TRANSFER', 'BANK_TRANSFER', 'OTHER'];

const draftRequestSchema = z.object({ message: z.string().trim().min(1).max(1000) }).strict();

// The model fills every field, with null for anything unknown. The API
// enforces this shape but not the enum values (the SDK moves enums into
// descriptions), so every field is checked again below.
const draftOutputSchema = z
  .object({
    kind: z.enum(['INCOME', 'EXPENSE']),
    propertyId: z.string().nullable(),
    unitId: z.string().nullable(),
    incomeType: z.enum(['RENT', 'OTHER']).nullable(),
    amount: z.string().nullable().describe('Exactly as written, e.g. "1,750.00". Never calculated.'),
    gstHst: z.string().nullable().describe('Only if stated separately.'),
    date: z.string().nullable().describe('YYYY-MM-DD'),
    payer: z.string().nullable().describe('Income only: who paid.'),
    vendor: z.string().nullable().describe('Expense only: who was paid.'),
    categoryCode: z.enum(CATEGORY_CODES).nullable(),
    paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
    notes: z.string().nullable(),
    questions: z.string().nullable().describe('What the staff member must fill in or check.'),
  })
  .strict();
// Thinking counts toward max_tokens, so this leaves room for it as well as
// the short JSON draft.
const MAX_TOKENS = 4096;
// The model's own starting point for extraction; raise only if the eval shows a gain.
const EFFORT = 'low';

// Each field is checked on its own and dropped (set to null) if invalid, so
// one bad value from the model doesn't lose the rest of the draft. Nothing
// here is saved: the staff member submits the form, which is validated again.
const fieldSchemas = {
  incomeType: z.enum(['RENT', 'OTHER']),
  date: z.iso.date(),
  payer: z.string().trim().min(1).max(200),
  vendor: z.string().trim().min(1).max(200),
  categoryCode: z.enum(CATEGORY_CODES),
  paymentMethod: z.enum(PAYMENT_METHODS),
  notes: z.string().trim().min(1).max(500),
  questions: z.string().trim().min(1).max(1000),
};

function checked(schema, value) {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function amountText(value) {
  const cents = typeof value === 'string' ? parseDollarsToCents(value) : null;
  return cents === null ? null : formatCents(cents);
}

function createLedgerAssistant({ anthropic, rentalStore, today }) {
  function referenceData() {
    const { properties, units, tenants, leases } = rentalStore.load();
    const date = today();
    const tenantNames = new Map(tenants.map((t) => [t.id, t.fullName]));
    // Only names and places: the model needs to match "Priya paid" to a unit,
    // not tenants' contact details.
    return {
      properties: properties.map((p) => ({
        propertyId: p.id,
        address: `${p.address}, ${p.city}`,
        units: units
          .filter((u) => u.propertyId === p.id)
          .map((u) => {
            const lease = leases.find((l) => l.unitId === u.id && leaseCovers(l, date));
            return { unitId: u.id, label: u.label, currentTenants: lease ? lease.tenantIds.map((id) => tenantNames.get(id)) : [] };
          }),
      })),
      expenseCategories: EXPENSE_CATEGORIES.map(({ code, name, treatment }) => ({ code, name, treatment })),
    };
  }

  function cleanDraft(input, reference) {
    const kind = input.kind === 'EXPENSE' ? 'EXPENSE' : 'INCOME';
    const property = reference.properties.find((p) => p.propertyId === input.propertyId);
    const unit = property?.units.find((u) => u.unitId === input.unitId);
    const draft = {
      kind,
      propertyId: property ? property.propertyId : null,
      unitId: unit ? unit.unitId : null,
      amount: amountText(input.amount),
      gstHst: kind === 'EXPENSE' ? amountText(input.gstHst) : null,
    };
    for (const [field, schema] of Object.entries(fieldSchemas)) {
      draft[field] = checked(schema, input[field]);
    }
    // Income entries have no payment method field.
    if (kind === 'INCOME') {
      draft.vendor = null;
      draft.categoryCode = null;
      draft.paymentMethod = null;
    } else {
      draft.payer = null;
      draft.incomeType = null;
    }
    return draft;
  }

  async function draft({ message }, staff) {
    if (!can(staff.role, 'ledger:record')) {
      return { error: 'forbidden' };
    }
    const reference = referenceData();
    // Structured output rather than a forced tool call: this model rejects
    // tool_choice "tool" with a 400.
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT, format: zodOutputFormat(draftOutputSchema) },
      system: `${BASE_PROMPT}\n# Today's date\n\n${today()}\n\n# Reference data\n\n${JSON.stringify(reference, null, 2)}`,
      messages: [{ role: 'user', content: message }],
    });
    // A decline or a cut-off response has no complete draft to read.
    if (response.stop_reason !== 'end_turn') {
      return { error: 'no_draft' };
    }
    const text = response.content.find((block) => block.type === 'text');
    let input;
    try {
      input = JSON.parse(text.text);
    } catch {
      return { error: 'no_draft' };
    }
    if (typeof input !== 'object' || input === null) {
      return { error: 'no_draft' };
    }
    return { draft: cleanDraft(input, reference) };
  }

  return { draft };
}

module.exports = { createLedgerAssistant, draftRequestSchema };

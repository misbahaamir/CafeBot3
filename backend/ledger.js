const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./write-file');
const { z } = require('zod');
const { can } = require('./permissions');
const { parseDollarsToCents } = require('./money');
const { CATEGORY_CODES, categoryFor } = require('./categories');

// A single entry above this is almost certainly a typo (an extra zero or two).
const MAX_ENTRY_CENTS = 10_000_000_00;

const idSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
const amountSchema = z
  .string()
  .max(20)
  .transform((text, ctx) => {
    const cents = parseDollarsToCents(text);
    if (cents === null || cents > MAX_ENTRY_CENTS) {
      ctx.addIssue({ code: 'custom', message: 'Enter an amount like 1750 or 1,750.00 (up to $10,000,000)' });
      return z.NEVER;
    }
    return cents;
  });
const positiveAmountSchema = amountSchema.refine((cents) => cents > 0, 'Amount must be more than zero');
const notesSchema = z.string().trim().max(500).default('');

const incomeInputSchema = z
  .object({
    propertyId: idSchema,
    unitId: idSchema.nullable().default(null),
    type: z.enum(['RENT', 'OTHER']),
    amount: positiveAmountSchema,
    receivedOn: z.iso.date(),
    payer: z.string().trim().min(1).max(200),
    notes: notesSchema,
  })
  .strict();

const expenseInputSchema = z
  .object({
    propertyId: idSchema,
    unitId: idSchema.nullable().default(null),
    categoryCode: z.enum(CATEGORY_CODES),
    // Only for CURRENT/CAPITAL categories: the accountant may treat a specific
    // item differently from its category's default.
    treatment: z.enum(['CURRENT', 'CAPITAL']).optional(),
    vendor: z.string().trim().min(1).max(200),
    amount: positiveAmountSchema,
    gstHst: amountSchema.default(0),
    paidOn: z.iso.date(),
    paymentMethod: z.enum(['CASH', 'CHEQUE', 'CREDIT_CARD', 'DEBIT', 'E_TRANSFER', 'BANK_TRANSFER', 'OTHER']),
    notes: notesSchema,
    acknowledgeNotDeductible: z.boolean().default(false),
  })
  .strict();

const entryParamsSchema = z.object({ kind: z.enum(['income', 'expense']), id: z.uuid() });
const voidBodySchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
const listQuerySchema = z
  .object({
    year: z.string().regex(/^\d{4}$/).optional(),
    propertyId: idSchema.optional(),
  })
  .strict();

const KINDS = {
  income: { file: 'income.json', entityType: 'INCOME', dateField: 'receivedOn' },
  expense: { file: 'expenses.json', entityType: 'EXPENSE', dateField: 'paidOn' },
};

function createLedger(dataDir, auditLog, { rentalStore, today }) {
  function readAll(kind) {
    const filePath = path.join(dataDir, KINDS[kind].file);
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : [];
  }

  // JSON files have no transactions: if the audit entry can't be written, the
  // previous file contents are put back so no change is left unlogged.
  function commit(kind, entries, auditEntry) {
    const filePath = path.join(dataDir, KINDS[kind].file);
    const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    writeFileAtomic(filePath, JSON.stringify(entries, null, 2));
    try {
      auditLog.append({ entityType: KINDS[kind].entityType, ...auditEntry });
    } catch (err) {
      if (previous === null) fs.unlinkSync(filePath);
      else writeFileAtomic(filePath, previous);
      throw err;
    }
  }

  function checkPlace({ propertyId, unitId }) {
    const { properties, units } = rentalStore.load();
    if (!properties.some((p) => p.id === propertyId)) {
      return 'unknown_property';
    }
    if (unitId !== null && !units.some((u) => u.id === unitId && u.propertyId === propertyId)) {
      return 'unknown_unit';
    }
    return null;
  }

  function create(kind, fields, staff) {
    if (!can(staff.role, 'ledger:record')) {
      return { error: 'forbidden' };
    }
    const placeError = checkPlace(fields);
    if (placeError) {
      return { error: placeError };
    }
    if (fields[KINDS[kind].dateField] > today()) {
      return { error: 'future_date' };
    }
    const entry = {
      id: crypto.randomUUID(),
      ...fields,
      status: 'ACTIVE',
      voidReason: null,
      createdBy: staff.username,
      createdAt: new Date().toISOString(),
    };
    commit(kind, [...readAll(kind), entry], {
      actorType: 'STAFF',
      actorId: staff.username,
      action: 'CREATE',
      entityId: entry.id,
      before: null,
      after: entry,
      reason: null,
    });
    return { entry };
  }

  function createIncome({ amount, ...rest }, staff) {
    return create('income', { ...rest, amountCents: amount }, staff);
  }

  function createExpense({ amount, gstHst, treatment, acknowledgeNotDeductible, ...rest }, staff) {
    const category = categoryFor(rest.categoryCode);
    if (category.treatment === 'NOT_DEDUCTIBLE') {
      if (treatment !== undefined) {
        return { error: 'treatment_not_allowed' };
      }
      // Recorded anyway (it is still money spent), but only once someone has
      // seen that it won't count as a deduction.
      if (!acknowledgeNotDeductible) {
        return { error: 'not_deductible_unconfirmed' };
      }
    }
    return create(
      'expense',
      { ...rest, amountCents: amount, gstHstCents: gstHst, treatment: treatment ?? category.treatment },
      staff
    );
  }

  function voidEntry(kind, id, reason, staff) {
    if (!can(staff.role, 'ledger:record')) {
      return { error: 'forbidden' };
    }
    const entries = readAll(kind);
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
      return { error: 'entry_not_found' };
    }
    if (entry.status === 'VOID') {
      return { error: 'already_void' };
    }
    entry.status = 'VOID';
    entry.voidReason = reason;
    commit(kind, entries, {
      actorType: 'STAFF',
      actorId: staff.username,
      action: 'VOID',
      entityId: id,
      before: { status: 'ACTIVE' },
      after: { status: 'VOID' },
      reason,
    });
    return { entry };
  }

  function list({ year, propertyId }, staff) {
    if (!can(staff.role, 'ledger:view')) {
      return { error: 'forbidden' };
    }
    const matches = (kind) => (entry) =>
      (!year || entry[KINDS[kind].dateField].startsWith(`${year}-`)) && (!propertyId || entry.propertyId === propertyId);
    const newestFirst = (kind) => (a, b) =>
      b[KINDS[kind].dateField].localeCompare(a[KINDS[kind].dateField]) || b.createdAt.localeCompare(a.createdAt);
    const income = readAll('income').filter(matches('income')).sort(newestFirst('income'));
    const expenses = readAll('expense').filter(matches('expense')).sort(newestFirst('expense'));

    // Voided entries stay in the lists but never count toward totals.
    const active = (entries) => entries.filter((e) => e.status === 'ACTIVE');
    const sum = (entries, field) => entries.reduce((total, e) => total + e[field], 0);
    const activeExpenses = active(expenses);
    const withTreatment = (treatment) => activeExpenses.filter((e) => e.treatment === treatment);
    return {
      income,
      expenses,
      totals: {
        incomeCents: sum(active(income), 'amountCents'),
        currentExpensesCents: sum(withTreatment('CURRENT'), 'amountCents'),
        capitalExpensesCents: sum(withTreatment('CAPITAL'), 'amountCents'),
        notDeductibleCents: sum(withTreatment('NOT_DEDUCTIBLE'), 'amountCents'),
        gstHstPaidCents: sum(activeExpenses, 'gstHstCents'),
      },
    };
  }

  return { readAll, createIncome, createExpense, voidEntry, list };
}

module.exports = {
  createLedger,
  incomeInputSchema,
  expenseInputSchema,
  entryParamsSchema,
  voidBodySchema,
  listQuerySchema,
};

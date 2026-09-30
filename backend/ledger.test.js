const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLedger, incomeInputSchema, expenseInputSchema, listQuerySchema } = require('./ledger');
const { createAuditLog } = require('./audit');

const RENTAL_STORE = {
  load: () => ({
    properties: [{ id: 'maple-row' }, { id: 'harbour-lane' }],
    units: [{ id: 'maple-1', propertyId: 'maple-row' }, { id: 'harbour-2b', propertyId: 'harbour-lane' }],
  }),
};
const BOOKKEEPER = { username: 'bea', role: 'BOOKKEEPER' };
const ACCOUNTANT = { username: 'al', role: 'ACCOUNTANT' };

function setup({ auditLog } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentledger-ledger-'));
  const log = auditLog || createAuditLog(path.join(dir, 'audit-log.jsonl'));
  const ledger = createLedger(dir, log, { rentalStore: RENTAL_STORE, today: () => '2026-09-30' });
  return { dir, log, ledger };
}

const income = (fields = {}) =>
  incomeInputSchema.parse({
    propertyId: 'maple-row', unitId: 'maple-1', type: 'RENT', amount: '2,152.50',
    receivedOn: '2026-09-01', payer: 'Jordan Tremblay', ...fields,
  });
const expense = (fields = {}) =>
  expenseInputSchema.parse({
    propertyId: 'maple-row', categoryCode: 'REPAIRS_MAINTENANCE', vendor: 'Ace Plumbing',
    amount: '300', gstHst: '39', paidOn: '2026-09-10', paymentMethod: 'CREDIT_CARD', ...fields,
  });

test('recording income stores cents, the recorder, and an audit entry', () => {
  const { log, ledger } = setup();
  const { entry } = ledger.createIncome(income(), BOOKKEEPER);
  assert.equal(entry.amountCents, 215250);
  assert.equal(entry.status, 'ACTIVE');
  assert.equal(entry.createdBy, 'bea');
  const [audit] = log.readAll();
  assert.deepEqual([audit.action, audit.entityType, audit.entityId, audit.actorId], ['CREATE', 'INCOME', entry.id, 'bea']);
});

test('expenses take their treatment from the category unless overridden', () => {
  const { ledger } = setup();
  assert.equal(ledger.createExpense(expense(), BOOKKEEPER).entry.treatment, 'CURRENT');
  assert.equal(ledger.createExpense(expense({ categoryCode: 'APPLIANCES' }), BOOKKEEPER).entry.treatment, 'CAPITAL');
  assert.equal(ledger.createExpense(expense({ treatment: 'CAPITAL' }), BOOKKEEPER).entry.treatment, 'CAPITAL');
  assert.equal(ledger.createExpense(expense(), BOOKKEEPER).entry.gstHstCents, 3900);
});

test('a non-deductible expense needs an explicit acknowledgement and keeps its treatment', () => {
  const { ledger } = setup();
  const principal = { categoryCode: 'MORTGAGE_PRINCIPAL', vendor: 'Bank', gstHst: '0' };
  assert.deepEqual(ledger.createExpense(expense(principal), BOOKKEEPER), { error: 'not_deductible_unconfirmed' });
  assert.deepEqual(
    ledger.createExpense(expense({ ...principal, treatment: 'CURRENT', acknowledgeNotDeductible: true }), BOOKKEEPER),
    { error: 'treatment_not_allowed' }
  );
  const { entry } = ledger.createExpense(expense({ ...principal, acknowledgeNotDeductible: true }), BOOKKEEPER);
  assert.equal(entry.treatment, 'NOT_DEDUCTIBLE');
});

test('entries must point to a real property and one of its units, and not be dated in the future', () => {
  const { ledger } = setup();
  assert.deepEqual(ledger.createIncome(income({ propertyId: 'nowhere' }), BOOKKEEPER), { error: 'unknown_property' });
  assert.deepEqual(ledger.createIncome(income({ unitId: 'harbour-2b' }), BOOKKEEPER), { error: 'unknown_unit' });
  assert.deepEqual(ledger.createIncome(income({ receivedOn: '2026-10-01' }), BOOKKEEPER), { error: 'future_date' });
  assert.ok(ledger.createIncome(income({ receivedOn: '2026-09-30', unitId: null }), BOOKKEEPER).entry);
  assert.equal(ledger.readAll('income').length, 1);
});

test('only ADMIN, MANAGER and BOOKKEEPER record or void; ACCOUNTANT only views', () => {
  const { ledger } = setup();
  for (const role of ['ADMIN', 'MANAGER', 'BOOKKEEPER']) {
    assert.ok(ledger.createIncome(income(), { username: 'x', role }).entry, role);
  }
  const { id } = ledger.readAll('income')[0];
  for (const role of ['ACCOUNTANT', 'BARISTA', undefined]) {
    const staff = { username: 'x', role };
    assert.deepEqual(ledger.createIncome(income(), staff), { error: 'forbidden' });
    assert.deepEqual(ledger.createExpense(expense(), staff), { error: 'forbidden' });
    assert.deepEqual(ledger.voidEntry('income', id, 'Entered twice by mistake', staff), { error: 'forbidden' });
  }
  assert.ok(ledger.list({}, ACCOUNTANT).income);
  assert.deepEqual(ledger.list({}, { username: 'x', role: 'BARISTA' }), { error: 'forbidden' });
});

test('voiding keeps the entry with its reason, is audited, and cannot be repeated', () => {
  const { log, ledger } = setup();
  const { entry } = ledger.createExpense(expense(), BOOKKEEPER);
  const voided = ledger.voidEntry('expense', entry.id, 'Duplicate of the invoice entry', BOOKKEEPER).entry;
  assert.deepEqual([voided.status, voided.voidReason], ['VOID', 'Duplicate of the invoice entry']);
  assert.equal(ledger.readAll('expense').length, 1);
  const audit = log.readAll().at(-1);
  assert.deepEqual([audit.action, audit.entityType, audit.reason], ['VOID', 'EXPENSE', 'Duplicate of the invoice entry']);
  assert.deepEqual(ledger.voidEntry('expense', entry.id, 'Duplicate of the invoice entry', BOOKKEEPER), { error: 'already_void' });
  assert.deepEqual(ledger.voidEntry('income', entry.id, 'Duplicate of the invoice entry', BOOKKEEPER), { error: 'entry_not_found' });
});

test('totals are computed in cents, exclude voided entries, and follow the filters', () => {
  const { ledger } = setup();
  ledger.createIncome(income(), BOOKKEEPER);
  ledger.createIncome(income({ amount: '0.01', type: 'OTHER' }), BOOKKEEPER);
  const voidMe = ledger.createIncome(income({ amount: '999' }), BOOKKEEPER).entry;
  ledger.voidEntry('income', voidMe.id, 'Wrong tenant entered', BOOKKEEPER);
  ledger.createIncome(income({ receivedOn: '2025-12-31' }), BOOKKEEPER);
  ledger.createIncome(income({ propertyId: 'harbour-lane', unitId: 'harbour-2b', amount: '1,750' }), BOOKKEEPER);
  ledger.createExpense(expense({ amount: '0.10', gstHst: '0.01' }), BOOKKEEPER);
  ledger.createExpense(expense({ amount: '0.20', gstHst: '0.02' }), BOOKKEEPER);
  ledger.createExpense(expense({ categoryCode: 'APPLIANCES', amount: '1,299.99', gstHst: '169' }), BOOKKEEPER);
  ledger.createExpense(expense({ categoryCode: 'LAND_TRANSFER_TAX', amount: '5000', gstHst: '0', acknowledgeNotDeductible: true }), BOOKKEEPER);

  const maple2026 = ledger.list({ year: '2026', propertyId: 'maple-row' }, BOOKKEEPER);
  assert.equal(maple2026.income.length, 3);
  assert.equal(maple2026.income.find((e) => e.id === voidMe.id).status, 'VOID');
  assert.deepEqual(maple2026.totals, {
    incomeCents: 215251,
    currentExpensesCents: 30,
    capitalExpensesCents: 129999,
    notDeductibleCents: 500000,
    gstHstPaidCents: 16903,
  });
  assert.equal(ledger.list({ year: '2025' }, BOOKKEEPER).totals.incomeCents, 215250);
  assert.equal(ledger.list({}, BOOKKEEPER).totals.incomeCents, 215251 + 215250 + 175000);
});

test('if the audit entry cannot be written, the entry is not kept', () => {
  const failing = { append: () => { throw new Error('disk full'); } };
  const { dir, ledger } = setup({ auditLog: failing });
  assert.throws(() => ledger.createIncome(income(), BOOKKEEPER), /disk full/);
  assert.equal(fs.existsSync(path.join(dir, 'income.json')), false);
});

test('inputs are bounded before they reach the ledger', () => {
  const base = { propertyId: 'maple-row', type: 'RENT', receivedOn: '2026-09-01', payer: 'x' };
  for (const amount of ['0', '-5', '1.999', '10,000,000.01', 1750]) {
    assert.equal(incomeInputSchema.safeParse({ ...base, amount }).success, false, String(amount));
  }
  assert.equal(incomeInputSchema.safeParse({ ...base, amount: '10,000,000' }).success, true);
  assert.equal(incomeInputSchema.safeParse({ ...base, amount: '5', receivedOn: '2026-02-30' }).success, false);
  assert.equal(incomeInputSchema.safeParse({ ...base, amount: '5', status: 'VOID' }).success, false);
  assert.equal(expenseInputSchema.safeParse({ ...expense(), categoryCode: 'GROCERIES' }).success, false);
  assert.equal(listQuerySchema.safeParse({ year: '26' }).success, false);
});

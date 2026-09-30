const test = require('node:test');
const assert = require('node:assert/strict');
const { createLedgerAssistant } = require('./ledger-assistant');

const RENTAL_STORE = {
  load: () => ({
    properties: [{ id: 'harbour-lane', address: '480 Harbour Lane', city: 'Halifax' }],
    units: [{ id: 'harbour-2b', propertyId: 'harbour-lane', label: 'Apt 2B' }],
    tenants: [{ id: 't1', fullName: 'Priya Nair', email: 'priya@example.com', phone: '902-555-0101' }],
    leases: [{ id: 'l1', unitId: 'harbour-2b', tenantIds: ['t1'], startDate: '2026-07-01', endDate: '2027-06-30' }],
  }),
};
const MANAGER = { username: 'maria', role: 'MANAGER' };

function setup(toolInput) {
  const calls = [];
  const anthropic = {
    messages: {
      create: async (params) => {
        calls.push(params);
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu', name: 'draft_entry', input: toolInput }] };
      },
    },
  };
  return { calls, assistant: createLedgerAssistant({ anthropic, rentalStore: RENTAL_STORE, today: () => '2026-09-30' }) };
}

test('a draft keeps valid fields, normalises the amount, and forces the draft tool', async () => {
  const { calls, assistant } = setup({
    kind: 'INCOME', propertyId: 'harbour-lane', unitId: 'harbour-2b', incomeType: 'RENT',
    amount: '1,750', date: '2026-09-30', payer: 'Priya Nair', paymentMethod: 'E_TRANSFER',
  });
  const { draft } = await assistant.draft({ message: 'Priya paid $1,750 rent today by e-transfer' }, MANAGER);
  assert.deepEqual(draft, {
    kind: 'INCOME', propertyId: 'harbour-lane', unitId: 'harbour-2b', amount: '$1750.00', gstHst: null,
    incomeType: 'RENT', date: '2026-09-30', payer: 'Priya Nair', vendor: null, categoryCode: null,
    paymentMethod: null, notes: null, questions: null,
  });
  assert.deepEqual(calls[0].tool_choice, { type: 'tool', name: 'draft_entry' });
  assert.match(calls[0].system, /Priya Nair/);
  assert.match(calls[0].system, /2026-09-30/);
});

test('tenant contact details are never sent to the model', async () => {
  const { calls, assistant } = setup({ kind: 'INCOME' });
  await assistant.draft({ message: 'rent' }, MANAGER);
  assert.doesNotMatch(calls[0].system, /priya@example\.com|902-555-0101/);
});

test('invalid or invented values from the model are dropped, not passed on', async () => {
  const { assistant } = setup({
    kind: 'EXPENSE', propertyId: 'made-up', unitId: 'harbour-2b', amount: '500 plus HST', gstHst: '1.999',
    date: '2026-02-30', vendor: 'x'.repeat(201), categoryCode: 'GROCERIES', paymentMethod: 'BITCOIN',
    payer: 'Should not appear on an expense', questions: 'What was the tax amount?',
  });
  const { draft } = await assistant.draft({ message: 'Paid Ace $500 plus HST' }, MANAGER);
  assert.deepEqual(draft, {
    kind: 'EXPENSE', propertyId: null, unitId: null, amount: null, gstHst: null, incomeType: null,
    date: null, payer: null, vendor: null, categoryCode: null, paymentMethod: null, notes: null,
    questions: 'What was the tax amount?',
  });
});

test('only roles that record entries can ask for drafts', async () => {
  const { calls, assistant } = setup({ kind: 'INCOME' });
  assert.deepEqual(await assistant.draft({ message: 'rent' }, { username: 'al', role: 'ACCOUNTANT' }), { error: 'forbidden' });
  assert.equal(calls.length, 0);
});

test('a response without the draft tool is reported, not guessed', async () => {
  const anthropic = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure!' }] }) } };
  const assistant = createLedgerAssistant({ anthropic, rentalStore: RENTAL_STORE, today: () => '2026-09-30' });
  assert.deepEqual(await assistant.draft({ message: 'rent' }, MANAGER), { error: 'no_draft' });
});

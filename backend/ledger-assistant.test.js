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

const NULL_DRAFT = {
  kind: 'INCOME', propertyId: null, unitId: null, incomeType: null, amount: null, gstHst: null, date: null,
  payer: null, vendor: null, categoryCode: null, paymentMethod: null, notes: null, questions: null,
};

function setup(output, response) {
  const calls = [];
  const anthropic = {
    messages: {
      create: async (params) => {
        calls.push(params);
        return response || { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ...NULL_DRAFT, ...output }) }] };
      },
    },
  };
  return { calls, assistant: createLedgerAssistant({ anthropic, rentalStore: RENTAL_STORE, today: () => '2026-09-30' }) };
}

test('a draft keeps valid fields and normalises the amount, using structured output instead of a forced tool', async () => {
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
  // Claude Sonnet 5.5 rejects tool_choice "tool"/"any" with a 400.
  assert.equal(calls[0].tool_choice, undefined);
  assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].output_config.format.type, 'json_schema');
  assert.equal(calls[0].output_config.effort, 'low');
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

test('a refusal, a cut-off response, or output that is not JSON is reported, not guessed', async () => {
  const cases = [
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure!' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'null' }] },
    { stop_reason: 'end_turn', content: [] },
    { stop_reason: 'refusal', content: [{ type: 'text', text: '{"kind":"INCOME"}' }] },
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"kind":"INC' }] },
  ];
  for (const response of cases) {
    const { assistant } = setup(null, response);
    assert.deepEqual(await assistant.draft({ message: 'rent' }, MANAGER), { error: 'no_draft' }, JSON.stringify(response));
  }
});

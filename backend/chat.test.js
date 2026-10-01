const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicAssistant, chatRequestSchema } = require('./chat');
const { createRateLimiter } = require('./rate-limit');

const LISTING = {
  unitId: 'maple-2', address: '12 Maple Row', city: 'Toronto', province: 'ON', propertyUseType: 'RESIDENTIAL',
  label: 'Unit 2', bedrooms: 1, bathrooms: 1, rentCents: 165000, availableFrom: '2026-11-01', description: 'Bright.',
};
const OFFICE = { companyName: 'Sample PM', phone: '416-555-0100', email: 'office@example.com', officeHours: '9-5', emergencyMaintenancePhone: null, faqs: [] };

function setup({ responses = [], submitLimit = 5 } = {}) {
  const calls = [];
  const created = [];
  const anthropic = {
    messages: {
      create: async (params) => {
        calls.push(structuredClone(params));
        return responses.shift();
      },
    },
  };
  const assistant = createPublicAssistant({
    anthropic,
    rentalStore: { listings: () => [LISTING] },
    requestStore: {
      createMaintenance: (fields) => { created.push(fields); return { id: 'req-1', status: 'NEW', ...fields }; },
      createViewing: (fields) =>
        fields.unitId === 'maple-2' ? { id: 'req-2', status: 'NEW', ...fields } : { error: 'unit_not_listed' },
    },
    loadOffice: () => OFFICE,
    today: () => '2026-09-30',
    submitLimiter: createRateLimiter({ limit: submitLimit, windowMs: 60000 }),
  });
  return { assistant, calls, created };
}

const MAINTENANCE = {
  name: 'Sam Lee', email: 'sam@example.com', address: '12 Maple Row, Unit 1',
  category: 'PLUMBING', urgency: 'ROUTINE', description: 'Kitchen tap drips all night.',
};

test('tool inputs from the model are validated before anything is saved', () => {
  const { assistant, created } = setup();
  for (const input of [
    { ...MAINTENANCE, email: 'not-an-email' },
    { ...MAINTENANCE, category: 'ROOF' },
    { ...MAINTENANCE, description: 'short' },
    { ...MAINTENANCE, name: 'x'.repeat(101) },
    { ...MAINTENANCE, tenantId: 'tenant-1' },
  ]) {
    assert.equal(assistant.runTool('submit_maintenance_request', input, 'ip').error, 'invalid_input');
  }
  assert.equal(assistant.runTool('lookup_lease', {}, 'ip').error, 'unknown_tool');
  assert.equal(assistant.runTool('submit_viewing_request', { name: 'A', email: 'a@example.com', unitId: '../x', preferredTimes: 'any' }, 'ip').error, 'invalid_input');
  assert.equal(created.length, 0);
});

test('valid requests return only a reference number and status', () => {
  const { assistant } = setup();
  assert.deepEqual(assistant.runTool('submit_maintenance_request', MAINTENANCE, 'ip'), { referenceNumber: 'req-1', status: 'NEW' });
  const viewing = { name: 'Ana', email: 'ana@example.com', unitId: 'maple-2', preferredTimes: 'Evenings' };
  assert.deepEqual(assistant.runTool('submit_viewing_request', viewing, 'ip'), { referenceNumber: 'req-2', status: 'NEW' });
  assert.deepEqual(assistant.runTool('submit_viewing_request', { ...viewing, unitId: 'maple-1' }, 'ip'), { error: 'unit_not_listed' });
});

test('one visitor can only submit a limited number of requests', () => {
  const { assistant, created } = setup({ submitLimit: 2 });
  assistant.runTool('submit_maintenance_request', MAINTENANCE, 'ip-a');
  assistant.runTool('submit_maintenance_request', MAINTENANCE, 'ip-a');
  assert.deepEqual(assistant.runTool('submit_maintenance_request', MAINTENANCE, 'ip-a'), { error: 'too_many_requests' });
  assert.equal(assistant.runTool('submit_maintenance_request', MAINTENANCE, 'ip-b').status, 'NEW');
  // Looking at listings is not limited.
  assert.ok(assistant.runTool('get_listings', {}, 'ip-a').listings);
  assert.equal(created.length, 3);
});

test('reply runs tools, returns the final text, and sends office info and the date in the system prompt', async () => {
  const { assistant, calls } = setup({
    responses: [
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'get_listings', input: {} }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Unit 2 is $1650.00 a month.' }] },
    ],
  });
  const reply = await assistant.reply({ message: 'Any vacancies?', conversationHistory: [] }, 'ip');
  assert.equal(reply, 'Unit 2 is $1650.00 a month.');
  assert.equal(calls.length, 2);
  assert.match(calls[0].system, /2026-09-30/);
  assert.match(calls[0].system, /416-555-0100/);
  const toolResult = calls[1].messages.at(-1).content[0];
  assert.equal(toolResult.tool_use_id, 'tu1');
  assert.equal(JSON.parse(toolResult.content).listings[0].rent, '$1650.00');
});

test('reply stops a runaway tool loop', async () => {
  const loop = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu', name: 'get_listings', input: {} }] };
  const { assistant, calls } = setup({ responses: Array.from({ length: 10 }, () => loop) });
  await assert.rejects(assistant.reply({ message: 'hi', conversationHistory: [] }, 'ip'), /tool rounds/);
  assert.equal(calls.length, 6);
});

test('chat requests are bounded', () => {
  assert.equal(chatRequestSchema.safeParse({ message: 'hi' }).success, true);
  assert.equal(chatRequestSchema.safeParse({ message: '   ' }).success, false);
  assert.equal(chatRequestSchema.safeParse({ message: 'x'.repeat(2001) }).success, false);
  const turn = { role: 'user', content: 'hi' };
  assert.equal(chatRequestSchema.safeParse({ message: 'hi', conversationHistory: Array(11).fill(turn) }).success, false);
  assert.equal(chatRequestSchema.safeParse({ message: 'hi', conversationHistory: [{ role: 'system', content: 'x' }] }).success, false);
  assert.equal(chatRequestSchema.safeParse({ message: 'hi', sessionId: 'x' }).success, false);
});

test('requests leave room for thinking, set effort explicitly, and turn a refusal into a safe reply', async () => {
  const { assistant, calls } = setup({
    responses: [{ stop_reason: 'refusal', content: [{ type: 'text', text: 'partial' }] }],
  });
  const reply = await assistant.reply({ message: 'hi', conversationHistory: [] }, 'ip');
  assert.match(reply, /contact the office/);
  assert.ok(calls[0].max_tokens >= 4096);
  assert.equal(calls[0].output_config.effort, 'low');
  assert.equal(calls[0].tool_choice, undefined);
});

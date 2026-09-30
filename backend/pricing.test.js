const test = require('node:test');
const assert = require('node:assert/strict');
const cases = require('./fixtures/pricing/cases.json');
const expected = require('./fixtures/pricing/expected.json');
const { createOrderState, runTool } = require('./server');

// Local time, because happy hour compares against the server's local clock.
function atLocalTime(t, hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 15, hours, minutes) });
}

function runSteps(steps) {
  const order = createOrderState();
  for (const step of steps) {
    const result = runTool({ name: step.tool, input: step.input }, order, 'pricing-test');
    if (step.expectError) {
      assert.deepEqual({ error: result.error, reason: result.reason }, { reason: undefined, ...step.expectError }, step.tool);
    } else {
      assert.equal(result.error, undefined, `${step.tool}: ${JSON.stringify(result)}`);
    }
  }
  return order;
}

function totalsOf(order) {
  const totals = runTool({ name: 'getOrderTotal', input: {} }, order, 'pricing-test');
  return {
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discount ? totals.discount.amountCents : 0,
    taxCents: totals.taxCents,
    deliveryFeeCents: totals.deliveryFeeCents,
    totalCents: totals.totalCents,
  };
}

test('every fixture case has a hand-written expected result', () => {
  assert.deepEqual(cases.map((c) => c.name).sort(), Object.keys(expected).sort());
});

for (const c of cases) {
  test(`totals to the cent: ${c.name}`, (t) => {
    atLocalTime(t, c.at);
    assert.deepEqual(totalsOf(runSteps(c.steps)), expected[c.name]);
  });
}

// Known mismatch: the fixed discount is applied once per cart line, not per
// item, so 3 croissants on one line get $1.50 off but 3 separate lines get
// $4.50. Left as a todo until the intended rule is decided.
test(
  'the bakery bundle discount does not depend on how croissants are split into lines',
  { todo: 'decide whether the bundle is $1.50 per bakery item or once per order' },
  (t) => {
    atLocalTime(t, '10:00');
    const latte = { tool: 'addItemToCart', input: { itemId: 'latte', size: 'small' } };
    const croissant = (quantity) => ({ tool: 'addItemToCart', input: { itemId: 'croissant', quantity } });
    const bundle = { tool: 'applyPromotion', input: { promotionId: 'bakery-bundle' } };

    const oneLine = totalsOf(runSteps([latte, croissant(3), bundle]));
    const threeLines = totalsOf(runSteps([latte, croissant(1), croissant(1), croissant(1), bundle]));
    assert.deepEqual(oneLine, threeLines);
  }
);

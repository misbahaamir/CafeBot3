const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCents, applyRate, withDisplayAmounts } = require('./money');

test('formatCents pads cents and handles zero and negatives', () => {
  assert.equal(formatCents(450), '$4.50');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(123456), '$1234.56');
  assert.equal(formatCents(-150), '-$1.50');
});

test('formatCents rejects non-integer amounts', () => {
  assert.throws(() => formatCents(4.5), TypeError);
  assert.throws(() => formatCents('450'), TypeError);
});

test('applyRate rounds half up', () => {
  assert.equal(applyRate(1000, 800), 80);
  // 8% of 1006 = 80.48 -> 80; of 1007 = 80.56 -> 81
  assert.equal(applyRate(1006, 800), 80);
  assert.equal(applyRate(1007, 800), 81);
  // 10% of 5 = 0.5 -> 1; of 4 = 0.4 -> 0
  assert.equal(applyRate(5, 1000), 1);
  assert.equal(applyRate(4, 1000), 0);
  assert.equal(applyRate(0, 800), 0);
  assert.equal(applyRate(999, 10000), 999);
});

test('applyRate rejects invalid input', () => {
  assert.throws(() => applyRate(-1, 800), RangeError);
  assert.throws(() => applyRate(10.5, 800), TypeError);
  assert.throws(() => applyRate(100, 8.5), TypeError);
  assert.throws(() => applyRate(100, -1), TypeError);
});

test('withDisplayAmounts converts *Cents keys recursively and leaves others alone', () => {
  const input = {
    name: 'Latte',
    quantity: 2,
    priceCents: 450,
    discount: null,
    items: [{ lineTotalCents: 900, options: ['oat milk'] }],
    totals: { totalCents: 972 },
  };
  assert.deepEqual(withDisplayAmounts(input), {
    name: 'Latte',
    quantity: 2,
    price: '$4.50',
    discount: null,
    items: [{ lineTotal: '$9.00', options: ['oat milk'] }],
    totals: { total: '$9.72' },
  });
});

test('withDisplayAmounts does not mutate its input', () => {
  const input = { priceCents: 300 };
  withDisplayAmounts(input);
  assert.deepEqual(input, { priceCents: 300 });
});

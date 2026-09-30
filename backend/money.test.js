const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCents, applyRate, withDisplayAmounts, parseDollarsToCents } = require('./money');

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
    label: 'Unit 2',
    bedrooms: 1,
    rentCents: 165000,
    listing: null,
    charges: [{ amountCents: 5000, utilities: ['water'] }],
    totals: { totalCents: 170000 },
  };
  assert.deepEqual(withDisplayAmounts(input), {
    label: 'Unit 2',
    bedrooms: 1,
    rent: '$1650.00',
    listing: null,
    charges: [{ amount: '$50.00', utilities: ['water'] }],
    totals: { total: '$1700.00' },
  });
});

test('withDisplayAmounts does not mutate its input', () => {
  const input = { priceCents: 300 };
  withDisplayAmounts(input);
  assert.deepEqual(input, { priceCents: 300 });
});

test('parseDollarsToCents reads typed amounts exactly and rejects anything unclear', () => {
  assert.equal(parseDollarsToCents('1,750'), 175000);
  assert.equal(parseDollarsToCents('$1750.5'), 175050);
  assert.equal(parseDollarsToCents(' 0.99 '), 99);
  assert.equal(parseDollarsToCents('0'), 0);
  // 1.005 * 100 is 100.49999999999999 in floating point; string math avoids it.
  assert.equal(parseDollarsToCents('1.01'), 101);
  assert.equal(parseDollarsToCents('4.35'), 435);
  for (const bad of ['1,75', '-5', '1.999', 'abc', '', '1 750', '1.', '.5', '99999999999999999']) {
    assert.equal(parseDollarsToCents(bad), null, bad);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { EXPENSE_CATEGORIES } = require('./categories');

test('category codes and T776 lines are unique, and only CURRENT categories have a line', () => {
  const codes = EXPENSE_CATEGORIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  const lines = EXPENSE_CATEGORIES.map((c) => c.t776Line).filter(Boolean);
  assert.equal(new Set(lines).size, lines.length);
  for (const category of EXPENSE_CATEGORIES) {
    assert.equal(category.t776Line !== null, category.treatment === 'CURRENT', category.code);
  }
});

test('the non-deductible items CRA lists are present so the form can warn about them', () => {
  const notDeductible = EXPENSE_CATEGORIES.filter((c) => c.treatment === 'NOT_DEDUCTIBLE').map((c) => c.code);
  assert.deepEqual(notDeductible.sort(), ['CRA_PENALTIES', 'LAND_TRANSFER_TAX', 'MORTGAGE_PRINCIPAL', 'OWN_LABOUR']);
});

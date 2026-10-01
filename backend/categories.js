// Category mapping must be reviewed by a CPA before production.
//
// Line numbers and names are from canada.ca "Rental expenses you can deduct"
// (page modified 2026-05-27) and "Rental expenses you cannot deduct" (page
// modified 2026-07-28), checked 2026-09-30:
// https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/rental-income/completing-form-t776-statement-real-estate-rentals/rental-expenses-you-deduct.html
// https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/rental-income/rental-expenses-you-cannot-deduct.html
// Re-check them against each year's T776 form.
//
// CAPITAL items have no T776 expense line: the accountant claims them as
// capital cost allowance (CCA), which this app does not calculate. The three
// capital categories follow canada.ca "Current expenses or capital expenses"
// (page modified 2026-07-28: improvements beyond original condition, and
// separate assets such as a refrigerator) and the furniture examples under
// line 8810 on the first page above:
// https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/rental-income/current-expenses-capital-expenses.html
const EXPENSE_CATEGORIES = [
  { code: 'ADVERTISING', name: 'Advertising', t776Line: '8521', treatment: 'CURRENT' },
  { code: 'INSURANCE', name: 'Insurance', t776Line: '8690', treatment: 'CURRENT' },
  { code: 'INTEREST_BANK', name: 'Interest and bank charges', t776Line: '8710', treatment: 'CURRENT' },
  { code: 'OFFICE', name: 'Office expenses', t776Line: '8810', treatment: 'CURRENT' },
  { code: 'PROFESSIONAL_FEES', name: 'Professional fees (legal and accounting)', t776Line: '8860', treatment: 'CURRENT' },
  { code: 'MANAGEMENT_FEES', name: 'Management and administration fees', t776Line: '8871', treatment: 'CURRENT' },
  { code: 'REPAIRS_MAINTENANCE', name: 'Repairs and maintenance', t776Line: '8960', treatment: 'CURRENT' },
  { code: 'SALARIES', name: 'Salaries, wages, and benefits', t776Line: '9060', treatment: 'CURRENT' },
  { code: 'PROPERTY_TAXES', name: 'Property taxes', t776Line: '9180', treatment: 'CURRENT' },
  { code: 'TRAVEL', name: 'Travel', t776Line: '9200', treatment: 'CURRENT' },
  { code: 'UTILITIES', name: 'Utilities', t776Line: '9220', treatment: 'CURRENT' },
  { code: 'MOTOR_VEHICLE', name: 'Motor vehicle expenses', t776Line: '9281', treatment: 'CURRENT' },
  { code: 'OTHER', name: 'Other expenses', t776Line: '9270', treatment: 'CURRENT' },
  { code: 'BUILDING_IMPROVEMENTS', name: 'Building improvements', t776Line: null, treatment: 'CAPITAL' },
  { code: 'FURNITURE_EQUIPMENT', name: 'Furniture and equipment', t776Line: null, treatment: 'CAPITAL' },
  { code: 'APPLIANCES', name: 'Appliances', t776Line: null, treatment: 'CAPITAL' },
  { code: 'MORTGAGE_PRINCIPAL', name: 'Mortgage principal', t776Line: null, treatment: 'NOT_DEDUCTIBLE' },
  { code: 'LAND_TRANSFER_TAX', name: 'Land transfer tax', t776Line: null, treatment: 'NOT_DEDUCTIBLE' },
  { code: 'CRA_PENALTIES', name: 'CRA penalties', t776Line: null, treatment: 'NOT_DEDUCTIBLE' },
  { code: 'OWN_LABOUR', name: "Owner's own labour", t776Line: null, treatment: 'NOT_DEDUCTIBLE' },
];

const CATEGORY_CODES = EXPENSE_CATEGORIES.map((c) => c.code);

function categoryFor(code) {
  return EXPENSE_CATEGORIES.find((c) => c.code === code);
}

module.exports = { EXPENSE_CATEGORIES, CATEGORY_CODES, categoryFor };

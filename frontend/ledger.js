function formatCents(cents) {
  return `$${Math.floor(cents / 100).toLocaleString('en-CA')}.${String(cents % 100).padStart(2, '0')}`;
}

// Every staff API call returns 401 once the session is gone or expired.
async function staffFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = 'login.html';
    throw new Error('not_signed_in');
  }
  return res;
}

function postJson(url, body) {
  return staffFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const $ = (id) => document.getElementById(id);

const TREATMENT_LABELS = { CURRENT: 'Current expenses', CAPITAL: 'Capital (claimed as CCA by your accountant)', NOT_DEDUCTIBLE: 'Not deductible' };
const CATEGORY_HELP = {
  CAPITAL: 'Capital items are not expensed in full; your accountant claims them as CCA.',
  NOT_DEDUCTIBLE: 'CRA does not allow this as a rental expense. It is recorded but kept out of deductible totals.',
};
const SAVE_ERRORS = {
  unknown_property: 'Choose a property.',
  unknown_unit: 'That unit is not in the chosen property.',
  future_date: 'The date cannot be in the future.',
  not_deductible_unconfirmed: 'Tick the box to confirm you understand this is not deductible.',
  treatment_not_allowed: 'A non-deductible category cannot be given a different treatment.',
  forbidden: 'You do not have permission to record entries.',
};

let properties = [];
let categories = [];
let canRecord = false;

function option(value, text) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = text;
  return el;
}

function kind() {
  return document.querySelector('input[name="kind"]:checked').value;
}

function fillPropertySelects() {
  $('propertyId').replaceChildren(option('', 'Choose…'), ...properties.map((p) => option(p.id, `${p.address}, ${p.city}`)));
  $('filter-property').append(...properties.map((p) => option(p.id, `${p.address}, ${p.city}`)));
}

function fillUnitSelect() {
  const property = properties.find((p) => p.id === $('propertyId').value);
  $('unitId').replaceChildren(option('', 'Whole property / not unit-specific'), ...(property ? property.units.map((u) => option(u.id, u.label)) : []));
}

function fillCategorySelect() {
  const select = $('categoryCode');
  select.replaceChildren(option('', 'Choose…'));
  for (const treatment of Object.keys(TREATMENT_LABELS)) {
    const group = document.createElement('optgroup');
    group.label = TREATMENT_LABELS[treatment];
    for (const c of categories.filter((cat) => cat.treatment === treatment)) {
      group.appendChild(option(c.code, c.t776Line ? `${c.name} (T776 line ${c.t776Line})` : c.name));
    }
    select.appendChild(group);
  }
}

function updateFormForKind() {
  const isExpense = kind() === 'EXPENSE';
  document.querySelector('.income-only').hidden = isExpense;
  document.querySelector('.expense-only').hidden = !isExpense;
  $('amount-label').textContent = isExpense ? 'Amount before GST/HST' : 'Amount';
  $('date-label').textContent = isExpense ? 'Date paid' : 'Date received';
  updateCategoryHelp();
}

function updateCategoryHelp() {
  const category = categories.find((c) => c.code === $('categoryCode').value);
  const treatment = category ? category.treatment : null;
  $('category-help').textContent = CATEGORY_HELP[treatment] || '';
  $('ack-label').hidden = treatment !== 'NOT_DEDUCTIBLE';
  $('treatment-label').hidden = treatment === 'NOT_DEDUCTIBLE';
  if (treatment !== 'NOT_DEDUCTIBLE') $('acknowledgeNotDeductible').checked = false;
  if (treatment === 'NOT_DEDUCTIBLE') $('treatment').value = '';
}

function resetForm() {
  $('entry-form').reset();
  $('draft-banner').hidden = true;
  $('form-error').textContent = '';
  $('date').value = new Date().toLocaleDateString('en-CA');
  fillUnitSelect();
  updateFormForKind();
}

// Fills only what the draft provides; the staff member checks and saves.
function applyDraft(draft) {
  resetForm();
  document.querySelector(`input[name="kind"][value="${draft.kind}"]`).checked = true;
  $('propertyId').value = draft.propertyId || '';
  fillUnitSelect();
  $('unitId').value = draft.unitId || '';
  const fields = { incomeType: draft.incomeType, payer: draft.payer, categoryCode: draft.categoryCode, vendor: draft.vendor,
    gstHst: draft.gstHst, paymentMethod: draft.paymentMethod, amount: draft.amount, date: draft.date, notes: draft.notes };
  for (const [id, value] of Object.entries(fields)) {
    if (value !== null) $(id).value = value;
  }
  updateFormForKind();
  const banner = $('draft-banner');
  banner.textContent = 'Filled in by the assistant. Check every field before saving.' + (draft.questions ? ` Assistant notes: ${draft.questions}` : '');
  banner.hidden = false;
}

async function requestDraft(event) {
  event.preventDefault();
  const message = $('assistant-input').value.trim();
  if (!message) return;
  const status = $('assistant-status');
  status.textContent = 'Working…';
  $('assistant-send').disabled = true;
  try {
    const res = await postJson('/api/staff/ledger/draft', { message });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      applyDraft(data.draft);
      status.textContent = '';
      $('assistant-input').value = '';
    } else {
      status.textContent = res.status === 429
        ? 'Too many requests. Please wait a minute.'
        : 'The assistant is unavailable. You can still fill in the form yourself.';
    }
  } catch (err) {
    status.textContent = 'Could not reach the assistant. You can still fill in the form yourself.';
  } finally {
    $('assistant-send').disabled = false;
  }
}

async function saveEntry(event) {
  event.preventDefault();
  const common = {
    propertyId: $('propertyId').value,
    unitId: $('unitId').value || null,
    amount: $('amount').value,
    notes: $('notes').value,
  };
  let url;
  let body;
  if (kind() === 'INCOME') {
    url = '/api/staff/ledger/income';
    body = { ...common, type: $('incomeType').value, payer: $('payer').value, receivedOn: $('date').value };
  } else {
    url = '/api/staff/ledger/expense';
    body = {
      ...common,
      categoryCode: $('categoryCode').value,
      vendor: $('vendor').value,
      gstHst: $('gstHst').value.trim() || '0',
      paidOn: $('date').value,
      paymentMethod: $('paymentMethod').value,
      acknowledgeNotDeductible: $('acknowledgeNotDeductible').checked,
    };
    if ($('treatment').value) body.treatment = $('treatment').value;
  }
  const res = await postJson(url, body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('form-error').textContent = SAVE_ERRORS[data.error]
      || (data.issues ? `Please check: ${data.issues.map((i) => i.path).join(', ')}.` : 'Could not save. Please try again.');
    return;
  }
  resetForm();
  await loadEntries();
}

function addLine(parent, text, className) {
  const line = document.createElement('div');
  line.textContent = text;
  if (className) line.className = className;
  parent.appendChild(line);
}

function placeName(entry) {
  const property = properties.find((p) => p.id === entry.propertyId);
  const unit = property && property.units.find((u) => u.id === entry.unitId);
  return [property ? property.address : entry.propertyId, unit ? unit.label : null].filter(Boolean).join(', ');
}

function renderEntry(entryKind, entry) {
  const card = document.createElement('article');
  card.className = 'entry' + (entry.status === 'VOID' ? ' entry-void' : '');
  if (entryKind === 'income') {
    addLine(card, `${entry.receivedOn} · ${formatCents(entry.amountCents)} · ${entry.type === 'RENT' ? 'Rent' : 'Other income'}`, 'entry-title');
    addLine(card, `From ${entry.payer} · ${placeName(entry)}`);
  } else {
    const category = categories.find((c) => c.code === entry.categoryCode);
    addLine(card, `${entry.paidOn} · ${formatCents(entry.amountCents)} + GST/HST ${formatCents(entry.gstHstCents)}`, 'entry-title');
    addLine(card, `${category ? category.name : entry.categoryCode} (${entry.treatment.replaceAll('_', ' ').toLowerCase()}) · ${entry.vendor}`);
    addLine(card, placeName(entry));
  }
  if (entry.notes) addLine(card, entry.notes, 'meta');
  addLine(card, `Recorded by ${entry.createdBy}`, 'meta');
  if (entry.status === 'VOID') {
    addLine(card, `VOID: ${entry.voidReason}`, 'void-reason');
  } else if (canRecord) {
    const button = document.createElement('button');
    button.textContent = 'Void';
    button.addEventListener('click', () => voidEntry(entryKind, entry.id));
    card.appendChild(button);
  }
  return card;
}

async function voidEntry(entryKind, id) {
  const reason = window.prompt('Why is this entry being voided? (at least 10 characters)');
  if (reason === null) return;
  if (reason.trim().length < 10) {
    window.alert('Please give a reason of at least 10 characters.');
    return;
  }
  const res = await postJson(`/api/staff/ledger/${entryKind}/${id}/void`, { reason: reason.trim() });
  if (!res.ok) {
    window.alert('Could not void this entry. The list has been refreshed.');
  }
  await loadEntries();
}

function renderList(container, entryKind, entries) {
  container.textContent = '';
  if (entries.length === 0) {
    container.textContent = 'No entries.';
    return;
  }
  for (const entry of entries) container.appendChild(renderEntry(entryKind, entry));
}

async function loadEntries() {
  const params = new URLSearchParams();
  if ($('filter-year').value) params.set('year', $('filter-year').value);
  if ($('filter-property').value) params.set('propertyId', $('filter-property').value);
  const res = await staffFetch(`/api/staff/ledger?${params}`);
  if (!res.ok) {
    $('income-list').textContent = res.status === 403 ? 'You do not have access to rent and expenses.' : 'Could not load entries.';
    return;
  }
  const { income, expenses, totals } = await res.json();
  const rows = [
    ['Income', totals.incomeCents],
    ['Current expenses', totals.currentExpensesCents],
    ['Capital items', totals.capitalExpensesCents],
    ['Not deductible', totals.notDeductibleCents],
    ['GST/HST paid', totals.gstHstPaidCents],
  ];
  $('totals').replaceChildren(...rows.flatMap(([label, cents]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = formatCents(cents);
    return [dt, dd];
  }));
  renderList($('income-list'), 'income', income);
  renderList($('expense-list'), 'expense', expenses);
}

async function init() {
  const me = await (await staffFetch('/api/staff/me')).json();
  $('signed-in-as').textContent = `Signed in as ${me.username} (${me.role})`;
  canRecord = me.permissions.includes('ledger:record');
  $('record-section').hidden = !canRecord;

  const [propertyRes, categoryRes] = await Promise.all([staffFetch('/api/staff/properties'), staffFetch('/api/staff/ledger/categories')]);
  properties = propertyRes.ok ? (await propertyRes.json()).properties : [];
  categories = (await categoryRes.json()).categories;
  fillPropertySelects();
  fillCategorySelect();
  $('filter-year').value = new Date().getFullYear();
  resetForm();
  await loadEntries();
}

document.querySelectorAll('input[name="kind"]').forEach((el) => el.addEventListener('change', updateFormForKind));
$('propertyId').addEventListener('change', fillUnitSelect);
$('categoryCode').addEventListener('change', updateCategoryHelp);
$('assistant-form').addEventListener('submit', requestDraft);
$('entry-form').addEventListener('submit', saveEntry);
$('filter-year').addEventListener('change', loadEntries);
$('filter-property').addEventListener('change', loadEntries);
init();

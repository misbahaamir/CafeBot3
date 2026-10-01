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

async function loadProperties() {
  const container = document.getElementById('properties');
  const res = await staffFetch('/api/staff/properties');
  if (!res.ok) {
    container.textContent = res.status === 403 ? 'You do not have access to properties.' : 'Could not load properties.';
    return;
  }
  const { date, properties } = await res.json();
  document.getElementById('as-of').textContent = `Occupancy as of ${date}`;
  container.textContent = '';
  if (properties.length === 0) {
    container.textContent = 'No properties yet.';
    return;
  }
  for (const property of properties) {
    container.appendChild(renderProperty(property));
  }
}

function renderProperty(property) {
  const card = document.createElement('section');
  card.className = 'property';

  const heading = document.createElement('h2');
  heading.textContent = `${property.address}, ${property.city}, ${property.province} ${property.postalCode}`;
  card.appendChild(heading);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${property.useType} · rental use ${property.rentalUsePercent}%`;
  card.appendChild(meta);

  const list = document.createElement('ul');
  list.className = 'units';
  for (const unit of property.units) {
    list.appendChild(renderUnit(unit));
  }
  card.appendChild(list);
  return card;
}

function renderUnit(unit) {
  const li = document.createElement('li');

  const title = document.createElement('div');
  title.className = 'unit-title';
  const beds = unit.bedrooms === 0 ? 'no bedrooms' : `${unit.bedrooms} bed`;
  title.textContent = `${unit.label} — ${beds}, ${unit.bathrooms} bath`;
  li.appendChild(title);

  const status = document.createElement('div');
  const lease = unit.currentLease;
  if (lease) {
    const term = lease.endDate ? `until ${lease.endDate}` : 'month to month';
    status.textContent = `Leased to ${lease.tenantNames.join(', ')} · ${formatCents(lease.rentCents)}/month, due day ${lease.rentDueDay} · ${term}`;
  } else {
    status.className = 'vacant';
    status.textContent = `Vacant · default rent ${formatCents(unit.defaultRentCents)}/month`;
  }
  li.appendChild(status);

  if (unit.listing) {
    const listing = document.createElement('div');
    listing.className = 'listing';
    listing.textContent = `Listed, available from ${unit.listing.availableFrom}`;
    li.appendChild(listing);
  }
  return li;
}

const NEXT_STATUS = {
  maintenance: { NEW: ['IN_PROGRESS', 'Start work'], IN_PROGRESS: ['COMPLETED', 'Mark completed'] },
  viewing: { NEW: ['SCHEDULED', 'Mark scheduled'], SCHEDULED: ['COMPLETED', 'Mark completed'] },
};
const CLOSED_STATUSES = ['COMPLETED', 'CANCELLED'];
const ACTION_ERRORS = {
  invalid_transition: 'This request was already changed. The list has been refreshed.',
  request_not_found: 'This request no longer exists. The list has been refreshed.',
  forbidden: 'You do not have permission to change requests.',
};

let canManageRequests = false;

async function loadRequests() {
  const res = await staffFetch('/api/staff/requests');
  const maintenance = document.getElementById('maintenance-requests');
  const viewing = document.getElementById('viewing-requests');
  if (!res.ok) {
    maintenance.textContent = 'Could not load requests.';
    viewing.textContent = '';
    return;
  }
  const data = await res.json();
  renderRequestList(maintenance, 'maintenance', data.maintenance);
  renderRequestList(viewing, 'viewing', data.viewing);
}

function renderRequestList(container, kind, requests) {
  const showClosed = document.getElementById('show-closed').checked;
  const shown = requests.filter((r) => showClosed || !CLOSED_STATUSES.includes(r.status));
  container.textContent = '';
  if (shown.length === 0) {
    container.textContent = showClosed ? 'No requests.' : 'No open requests.';
    return;
  }
  for (const request of shown) {
    container.appendChild(renderRequest(kind, request));
  }
}

function addLine(parent, text, className) {
  const line = document.createElement('div');
  line.textContent = text;
  if (className) line.className = className;
  parent.appendChild(line);
}

function renderRequest(kind, request) {
  const card = document.createElement('article');
  card.className = `request status-${request.status.toLowerCase()}`;

  const title = kind === 'maintenance'
    ? `${request.category.replaceAll('_', ' ')} · ${request.urgency}`
    : `Viewing · ${request.unitName}`;
  addLine(card, title, 'request-title');
  addLine(card, `${request.status.replaceAll('_', ' ')} · received ${new Date(request.createdAt).toLocaleString('en-CA')}`, 'meta');
  addLine(card, `Reference ${request.id}`, 'meta');
  addLine(card, [request.name, request.email, request.phone].filter(Boolean).join(' · '));
  if (kind === 'maintenance') {
    addLine(card, request.address);
    addLine(card, request.description, 'request-text');
  } else {
    addLine(card, `Preferred times: ${request.preferredTimes}`, 'request-text');
  }
  if (request.cancelReason) {
    addLine(card, `Cancelled: ${request.cancelReason}`, 'meta');
  }

  const next = NEXT_STATUS[kind][request.status];
  if (canManageRequests && next) {
    const actions = document.createElement('div');
    actions.className = 'request-actions';
    const advance = document.createElement('button');
    advance.textContent = next[1];
    advance.addEventListener('click', () => changeRequest(kind, request.id, 'status', { status: next[0] }));
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel request';
    cancel.addEventListener('click', () => {
      const reason = window.prompt('Why is this request being cancelled? (at least 10 characters)');
      if (reason === null) return;
      if (reason.trim().length < 10) {
        window.alert('Please give a reason of at least 10 characters.');
        return;
      }
      changeRequest(kind, request.id, 'cancel', { reason: reason.trim() });
    });
    actions.append(advance, cancel);
    card.appendChild(actions);
  }
  return card;
}

async function changeRequest(kind, id, action, body) {
  const res = await staffFetch(`/api/staff/requests/${kind}/${id}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    window.alert(ACTION_ERRORS[error] || 'Could not update the request. Please try again.');
  }
  await loadRequests();
}

async function showSignedInUser() {
  const res = await staffFetch('/api/staff/me');
  const { username, role, permissions } = await res.json();
  document.getElementById('signed-in-as').textContent = `Signed in as ${username} (${role})`;
  canManageRequests = permissions.includes('requests:manage');
  document.getElementById('requests-section').hidden = !permissions.includes('requests:view');
  document.getElementById('ledger-link').hidden = !permissions.includes('ledger:view');
}

async function loadAll() {
  if (!document.getElementById('requests-section').hidden) {
    await loadRequests();
  }
  await loadProperties();
}

async function signOut() {
  await fetch('/api/staff/logout', { method: 'POST' });
  window.location.href = 'login.html';
}

document.getElementById('refresh').addEventListener('click', loadAll);
document.getElementById('show-closed').addEventListener('change', loadRequests);
document.getElementById('sign-out').addEventListener('click', signOut);
showSignedInUser().then(loadAll);

const ORDER_STATUS_FLOW = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];
const FINAL_STATUSES = ['COMPLETED', 'CANCELLED'];
const MIN_CANCEL_REASON_LENGTH = 10;

// Filled from /api/staff/me. Only used to hide buttons; the server enforces
// the same permissions on every request.
let staffPermissions = [];

function formatCents(cents) {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
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

async function loadOrders() {
  const res = await staffFetch('/api/staff/orders');
  const orders = await res.json();
  renderOrders(orders);
}

function renderOrders(orders) {
  const container = document.getElementById('orders');
  container.textContent = '';

  if (orders.length === 0) {
    container.textContent = 'No orders yet.';
    return;
  }

  for (const order of [...orders].reverse()) {
    container.appendChild(renderOrder(order));
  }
}

function renderOrder(order) {
  const card = document.createElement('div');
  card.className = 'order';

  const header = document.createElement('div');
  header.className = 'order-header';

  const idEl = document.createElement('span');
  idEl.textContent = `Order ${order.id.slice(0, 8)}`;

  const statusEl = document.createElement('span');
  statusEl.className = `status status-${order.status}`;
  statusEl.textContent = order.status;

  header.appendChild(idEl);
  header.appendChild(statusEl);
  card.appendChild(header);

  const items = document.createElement('ul');
  items.className = 'items';
  for (const line of order.items) {
    const li = document.createElement('li');
    let text = `${line.quantity} x ${line.item}`;
    if (line.size) text += ` (${line.size})`;
    if (line.options && line.options.length) text += ` — ${line.options.join(', ')}`;
    li.textContent = text;
    items.appendChild(li);
  }
  card.appendChild(items);

  card.appendChild(renderFulfillment(order.fulfillment));

  const total = document.createElement('div');
  total.className = 'total';
  total.textContent = `Total: ${formatCents(order.totals.totalCents)}`;
  card.appendChild(total);

  if (order.status === 'CANCELLED') {
    const reason = document.createElement('div');
    reason.className = 'cancel-reason';
    reason.textContent = `Cancelled: ${order.cancelReason}`;
    card.appendChild(reason);
  }

  if (!FINAL_STATUSES.includes(order.status)) {
    const nextStatus = ORDER_STATUS_FLOW[ORDER_STATUS_FLOW.indexOf(order.status) + 1];
    const button = document.createElement('button');
    button.textContent = `Advance to ${nextStatus}`;
    button.addEventListener('click', () => advanceOrder(order.id, nextStatus));
    card.appendChild(button);
  }

  if (!FINAL_STATUSES.includes(order.status) && staffPermissions.includes('orders:cancel')) {
    const cancelButton = document.createElement('button');
    cancelButton.className = 'cancel';
    cancelButton.textContent = 'Cancel order';
    cancelButton.addEventListener('click', () => cancelOrder(order.id));
    card.appendChild(cancelButton);
  }

  const historyButton = document.createElement('button');
  historyButton.className = 'history-toggle';
  historyButton.textContent = 'History';
  const historyPanel = document.createElement('div');
  historyPanel.className = 'history';
  historyPanel.hidden = true;
  historyButton.addEventListener('click', () => toggleHistory(order.id, historyPanel));
  card.appendChild(historyButton);
  card.appendChild(historyPanel);

  return card;
}

async function toggleHistory(id, panel) {
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }

  panel.textContent = 'Loading…';
  panel.hidden = false;
  const res = await staffFetch(`/api/staff/orders/${id}/history`);
  if (!res.ok) {
    panel.textContent = 'Could not load history.';
    return;
  }

  const entries = await res.json();
  panel.textContent = '';
  const list = document.createElement('ul');
  for (const entry of entries) {
    list.appendChild(renderHistoryEntry(entry));
  }
  panel.appendChild(list);
}

function renderHistoryEntry(entry) {
  const li = document.createElement('li');

  const heading = document.createElement('div');
  heading.className = 'history-heading';
  heading.textContent = `${new Date(entry.createdAt).toLocaleString()} · ${describeActor(entry)} · ${entry.action}`;
  li.appendChild(heading);

  const details = entry.action === 'CREATE' ? ['Order placed'] : describeChanges(entry.before, entry.after);
  if (entry.reason) details.push(`Reason: ${entry.reason}`);
  for (const text of details) {
    const line = document.createElement('div');
    line.textContent = text;
    li.appendChild(line);
  }

  return li;
}

function describeActor(entry) {
  if (entry.actorType === 'CUSTOMER') return 'Customer';
  if (entry.actorType === 'STAFF') return entry.actorId ? `Staff (${entry.actorId})` : 'Staff';
  return 'System';
}

function describeChanges(before, after) {
  return Object.keys(after || {}).map((key) => {
    const from = before && key in before ? before[key] : '(none)';
    return `${key}: ${from} → ${after[key]}`;
  });
}

function renderFulfillment(fulfillment) {
  const div = document.createElement('div');
  const info = fulfillment.type === 'delivery' ? fulfillment.delivery : fulfillment.pickup;

  const lines = [`Fulfillment: ${fulfillment.type}`, `Name: ${info.name}`];
  if (fulfillment.type === 'pickup') {
    if (info.pickupTime) lines.push(`Pickup time: ${info.pickupTime}`);
  } else {
    lines.push(`Phone: ${info.phone}`);
    let address = info.address;
    if (info.apartmentUnit) address += `, ${info.apartmentUnit}`;
    lines.push(`Address: ${address}`);
    if (info.instructions) lines.push(`Instructions: ${info.instructions}`);
  }

  for (const line of lines) {
    const p = document.createElement('div');
    p.textContent = line;
    div.appendChild(p);
  }

  return div;
}

async function advanceOrder(id, status) {
  const res = await staffFetch(`/api/staff/orders/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Could not update order: ${body.error || res.status}`);
    return;
  }
  loadOrders();
}

async function cancelOrder(id) {
  const input = prompt(`Reason for cancelling (at least ${MIN_CANCEL_REASON_LENGTH} characters):`);
  if (input === null) return;
  const reason = input.trim();
  if (reason.length < MIN_CANCEL_REASON_LENGTH) {
    alert(`The reason must be at least ${MIN_CANCEL_REASON_LENGTH} characters.`);
    return;
  }

  const res = await staffFetch(`/api/staff/orders/${id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Could not cancel order: ${body.error || res.status}`);
    return;
  }
  loadOrders();
}

async function showSignedInUser() {
  const res = await staffFetch('/api/staff/me');
  const { username, role, permissions } = await res.json();
  staffPermissions = permissions;
  document.getElementById('signed-in-as').textContent = `Signed in as ${username} (${role})`;
}

async function signOut() {
  await fetch('/api/staff/logout', { method: 'POST' });
  window.location.href = 'login.html';
}

document.getElementById('refresh').addEventListener('click', loadOrders);
document.getElementById('sign-out').addEventListener('click', signOut);
showSignedInUser().then(loadOrders);

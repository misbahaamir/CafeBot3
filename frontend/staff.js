const ORDER_STATUS_FLOW = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];

function formatCents(cents) {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

async function loadOrders() {
  const res = await fetch('/api/staff/orders');
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

  const nextIndex = ORDER_STATUS_FLOW.indexOf(order.status) + 1;
  if (nextIndex < ORDER_STATUS_FLOW.length) {
    const nextStatus = ORDER_STATUS_FLOW[nextIndex];
    const button = document.createElement('button');
    button.textContent = `Advance to ${nextStatus}`;
    button.addEventListener('click', () => advanceOrder(order.id, nextStatus));
    card.appendChild(button);
  }

  return card;
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
  const res = await fetch(`/api/staff/orders/${id}/status`, {
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

document.getElementById('refresh').addEventListener('click', loadOrders);
loadOrders();

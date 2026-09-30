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

async function showSignedInUser() {
  const res = await staffFetch('/api/staff/me');
  const { username, role } = await res.json();
  document.getElementById('signed-in-as').textContent = `Signed in as ${username} (${role})`;
}

async function signOut() {
  await fetch('/api/staff/logout', { method: 'POST' });
  window.location.href = 'login.html';
}

document.getElementById('refresh').addEventListener('click', loadProperties);
document.getElementById('sign-out').addEventListener('click', signOut);
showSignedInUser().then(loadProperties);

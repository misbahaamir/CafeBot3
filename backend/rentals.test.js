const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRentalStore } = require('./rentals');

const SAMPLE_DIR = path.join(__dirname, '..', 'data', 'sample');
const MANAGER = { username: 'maria', role: 'MANAGER' };

// A copy of the sample data, with optional edits to one file.
function sampleDir(edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentledger-data-'));
  for (const file of fs.readdirSync(SAMPLE_DIR)) {
    fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(dir, file));
  }
  if (edit) {
    const filePath = path.join(dir, `${edit.file}.json`);
    fs.writeFileSync(filePath, JSON.stringify(edit.change(JSON.parse(fs.readFileSync(filePath, 'utf-8')))));
  }
  return dir;
}

function storeOn(dir, date = '2026-09-30') {
  return createRentalStore(dir, { today: () => date });
}

function unitIn(overview, unitId) {
  return overview.properties.flatMap((p) => p.units).find((u) => u.id === unitId);
}

test('the sample data loads and is consistent', () => {
  const data = storeOn(sampleDir()).load();
  assert.equal(data.properties.length, 2);
  assert.equal(data.units.length, 5);
});

test('overview picks the lease that covers today, including ones that start or end today', () => {
  const dir = sampleDir();
  assert.equal(unitIn(storeOn(dir, '2026-07-31').overview(MANAGER), 'maple-1').currentLease.id, 'lease-maple-1');
  assert.equal(unitIn(storeOn(dir, '2026-08-01').overview(MANAGER), 'maple-1').currentLease.id, 'lease-maple-1-renewal');
  assert.equal(unitIn(storeOn(dir, '2026-06-30').overview(MANAGER), 'harbour-2b').currentLease.id, 'lease-harbour-2b-old');
});

test('overview lists vacant units with no lease and names the tenants on leased ones', () => {
  const overview = storeOn(sampleDir()).overview(MANAGER);
  assert.equal(overview.date, '2026-09-30');
  assert.equal(unitIn(overview, 'maple-2').currentLease, null);
  assert.deepEqual(unitIn(overview, 'maple-1').currentLease.tenantNames, ['Jordan Tremblay', 'Riley Tremblay']);
  assert.equal(unitIn(overview, 'maple-1').currentLease.rentCents, 215250);
});

test('every staff role can view properties; unknown or missing roles cannot', () => {
  const store = storeOn(sampleDir());
  for (const role of ['ADMIN', 'MANAGER', 'BOOKKEEPER', 'ACCOUNTANT']) {
    assert.ok(store.overview({ username: 'x', role }).properties, role);
  }
  for (const role of ['BARISTA', undefined, 'toString']) {
    assert.deepEqual(store.overview({ username: 'x', role }), { error: 'forbidden' });
  }
});

test('invalid or inconsistent data is refused with a message naming the problem', () => {
  const cases = [
    [{ file: 'units', change: (u) => [{ ...u[0], defaultRentCents: 2100.5 }, ...u.slice(1)] }, /units\.json at 0\.defaultRentCents/],
    [{ file: 'properties', change: (p) => [{ ...p[0], province: 'XX' }, ...p.slice(1)] }, /properties\.json at 0\.province/],
    [{ file: 'leases', change: (l) => [{ ...l[0], startDate: '2026-02-30' }, ...l.slice(1)] }, /leases\.json at 0\.startDate/],
    [{ file: 'units', change: (u) => [{ ...u[0], propertyId: 'nowhere' }, ...u.slice(1)] }, /unknown property "nowhere"/],
    [{ file: 'leases', change: (l) => [{ ...l[0], tenantIds: ['t-ghost'] }, ...l.slice(1)] }, /unknown tenant "t-ghost"/],
    [{ file: 'leases', change: (l) => [{ ...l[0], endDate: '2025-01-01' }, ...l.slice(1)] }, /ends before it starts/],
    [{ file: 'leases', change: (l) => [{ ...l[0], endDate: '2026-08-01' }, ...l.slice(1)] }, /overlap on unit "maple-1"/],
    [{ file: 'tenants', change: (t) => [...t, t[0]] }, /Duplicate id "t-jordan"/],
  ];
  for (const [edit, message] of cases) {
    assert.throws(() => storeOn(sampleDir(edit)).load(), message);
  }
});

test('a missing data file points at the seed command', () => {
  const dir = sampleDir();
  fs.rmSync(path.join(dir, 'leases.json'));
  assert.throws(() => storeOn(dir).load(), /npm run seed:sample/);
});

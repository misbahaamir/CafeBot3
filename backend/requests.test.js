const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequestStore } = require('./requests');
const { createAuditLog } = require('./audit');

const LISTED = [{ unitId: 'maple-2' }];

function setup({ auditLog } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentledger-requests-'));
  const log = auditLog || createAuditLog(path.join(dir, 'audit-log.jsonl'));
  const store = createRequestStore(dir, log, { rentalStore: { listings: () => LISTED } });
  return { dir, log, store };
}

const MAINTENANCE = {
  name: 'Sam Lee',
  email: 'sam@example.com',
  address: '12 Maple Row, Unit 1',
  category: 'PLUMBING',
  urgency: 'ROUTINE',
  description: 'Kitchen tap drips all night.',
};

test('a maintenance request is saved as NEW and audited with the full record', () => {
  const { log, store } = setup();
  const request = store.createMaintenance(MAINTENANCE);
  assert.equal(request.status, 'NEW');
  assert.deepEqual(store.readAll('maintenance'), [request]);
  const [entry] = log.readAll();
  assert.equal(entry.actorType, 'PUBLIC');
  assert.equal(entry.action, 'CREATE');
  assert.equal(entry.entityType, 'MAINTENANCE_REQUEST');
  assert.equal(entry.entityId, request.id);
  assert.deepEqual(entry.after, request);
});

test('a viewing request is only accepted for a listed unit', () => {
  const { log, store } = setup();
  const fields = { name: 'Ana', email: 'ana@example.com', unitId: 'maple-1', preferredTimes: 'Weekday evenings' };
  assert.deepEqual(store.createViewing(fields), { error: 'unit_not_listed' });
  assert.deepEqual(store.readAll('viewing'), []);
  assert.equal(log.readAll().length, 0);

  const request = store.createViewing({ ...fields, unitId: 'maple-2' });
  assert.equal(request.unitId, 'maple-2');
  assert.equal(log.readAll()[0].entityType, 'VIEWING_REQUEST');
});

test('if the audit entry cannot be written, the request is not kept', () => {
  const failing = { append: () => { throw new Error('disk full'); } };
  const { dir, store } = setup({ auditLog: failing });
  assert.throws(() => store.createMaintenance(MAINTENANCE), /disk full/);
  assert.equal(fs.existsSync(path.join(dir, 'maintenance-requests.json')), false);

  const working = setup();
  working.store.createMaintenance(MAINTENANCE);
  const before = fs.readFileSync(path.join(working.dir, 'maintenance-requests.json'), 'utf-8');
  const broken = createRequestStore(working.dir, failing, { rentalStore: { listings: () => LISTED } });
  assert.throws(() => broken.createMaintenance(MAINTENANCE), /disk full/);
  assert.equal(fs.readFileSync(path.join(working.dir, 'maintenance-requests.json'), 'utf-8'), before);
});

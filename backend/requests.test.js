const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequestStore, requestParamsSchema, statusBodySchema, cancelBodySchema } = require('./requests');
const { createAuditLog } = require('./audit');

const LISTED = [{ unitId: 'maple-2' }];
const RENTAL_STORE = {
  listings: () => LISTED,
  load: () => ({
    properties: [{ id: 'maple-row', address: '12 Maple Row' }],
    units: [{ id: 'maple-2', propertyId: 'maple-row', label: 'Unit 2' }],
  }),
};
const MANAGER = { username: 'maria', role: 'MANAGER' };

function setup({ auditLog } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentledger-requests-'));
  const log = auditLog || createAuditLog(path.join(dir, 'audit-log.jsonl'));
  const store = createRequestStore(dir, log, { rentalStore: RENTAL_STORE });
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
  const broken = createRequestStore(working.dir, failing, { rentalStore: RENTAL_STORE });
  assert.throws(() => broken.createMaintenance(MAINTENANCE), /disk full/);
  assert.equal(fs.readFileSync(path.join(working.dir, 'maintenance-requests.json'), 'utf-8'), before);
});

const VIEWING = { name: 'Ana', email: 'ana@example.com', unitId: 'maple-2', preferredTimes: 'Evenings' };

test('staff list requests newest first, with the viewing unit named', async () => {
  const { store } = setup();
  const first = store.createMaintenance(MAINTENANCE);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = store.createMaintenance(MAINTENANCE);
  store.createViewing(VIEWING);
  const { maintenance, viewing } = store.list(MANAGER);
  assert.deepEqual(maintenance.map((r) => r.id), [second.id, first.id]);
  assert.equal(viewing[0].unitName, '12 Maple Row, Unit 2');
});

test('only admins and managers can see or change requests', () => {
  const { store } = setup();
  const { id } = store.createMaintenance(MAINTENANCE);
  assert.ok(store.list({ username: 'a', role: 'ADMIN' }).maintenance);
  for (const role of ['BOOKKEEPER', 'ACCOUNTANT', 'BARISTA', undefined]) {
    const staff = { username: 'x', role };
    assert.deepEqual(store.list(staff), { error: 'forbidden' }, role);
    assert.deepEqual(store.updateStatus('maintenance', id, 'IN_PROGRESS', staff), { error: 'forbidden' }, role);
    assert.deepEqual(store.cancel('maintenance', id, 'Tenant fixed it themselves', staff), { error: 'forbidden' }, role);
  }
  assert.equal(store.readAll('maintenance')[0].status, 'NEW');
});

test('status moves one step at a time and is audited', () => {
  const { log, store } = setup();
  const { id } = store.createMaintenance(MAINTENANCE);
  assert.deepEqual(store.updateStatus('maintenance', id, 'COMPLETED', MANAGER), { error: 'invalid_transition' });
  assert.deepEqual(store.updateStatus('maintenance', id, 'SCHEDULED', MANAGER), { error: 'invalid_transition' });
  assert.equal(store.updateStatus('maintenance', id, 'IN_PROGRESS', MANAGER).request.status, 'IN_PROGRESS');
  assert.deepEqual(store.updateStatus('maintenance', id, 'NEW', MANAGER), { error: 'invalid_transition' });
  assert.equal(store.updateStatus('maintenance', id, 'COMPLETED', MANAGER).request.status, 'COMPLETED');
  assert.deepEqual(store.updateStatus('maintenance', id, 'COMPLETED', MANAGER), { error: 'invalid_transition' });
  assert.deepEqual(store.cancel('maintenance', id, 'Changed my mind about it', MANAGER), { error: 'invalid_transition' });

  const changes = log.readAll().filter((e) => e.action === 'STATUS_CHANGE');
  assert.deepEqual(changes.map((e) => [e.actorId, e.before.status, e.after.status]), [
    ['maria', 'NEW', 'IN_PROGRESS'],
    ['maria', 'IN_PROGRESS', 'COMPLETED'],
  ]);

  const viewing = store.createViewing(VIEWING);
  assert.equal(store.updateStatus('viewing', viewing.id, 'SCHEDULED', MANAGER).request.status, 'SCHEDULED');
  assert.deepEqual(store.updateStatus('maintenance', viewing.id, 'IN_PROGRESS', MANAGER), { error: 'request_not_found' });
});

test('cancelling keeps the request, records the reason, and is audited', () => {
  const { log, store } = setup();
  const { id } = store.createViewing(VIEWING);
  const { request } = store.cancel('viewing', id, 'Applicant found another place', MANAGER);
  assert.equal(request.status, 'CANCELLED');
  assert.equal(store.readAll('viewing')[0].cancelReason, 'Applicant found another place');
  const entry = log.readAll().at(-1);
  assert.deepEqual([entry.action, entry.entityType, entry.reason, entry.before.status], ['CANCEL', 'VIEWING_REQUEST', 'Applicant found another place', 'NEW']);
  assert.deepEqual(store.updateStatus('viewing', id, 'SCHEDULED', MANAGER), { error: 'invalid_transition' });
});

test('route inputs are bounded', () => {
  const id = '6f1c2f0e-8a4b-4c1d-9e2f-3a4b5c6d7e8f';
  assert.equal(requestParamsSchema.safeParse({ kind: 'maintenance', id }).success, true);
  assert.equal(requestParamsSchema.safeParse({ kind: 'toString', id }).success, false);
  assert.equal(requestParamsSchema.safeParse({ kind: 'viewing', id: '../x' }).success, false);
  assert.equal(statusBodySchema.safeParse({ status: 'CANCELLED' }).success, false);
  assert.equal(cancelBodySchema.safeParse({ reason: 'too short' }).success, false);
  assert.equal(cancelBodySchema.safeParse({ reason: 'x'.repeat(501) }).success, false);
  assert.equal(cancelBodySchema.safeParse({ reason: 'A valid reason here' }).success, true);
});

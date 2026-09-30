const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAuditLog } = require('./audit');
const { createOrderStore } = require('./orders');

const SESSION_ID = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
const MANAGER = { username: 'maria', role: 'MANAGER' };
const BARISTA = { username: 'ben', role: 'BARISTA' };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafebot-orders-'));
  const ordersPath = path.join(dir, 'orders.json');
  fs.writeFileSync(ordersPath, '[]');
  const auditLog = createAuditLog(path.join(dir, 'audit-log.jsonl'));
  return { ordersPath, auditLog, store: createOrderStore(ordersPath, auditLog) };
}

function sampleOrder(id = 'order-1') {
  return { id, status: 'NEW', items: [], totals: { totalCents: 450 } };
}

const failingAuditLog = {
  append() {
    throw new Error('disk full');
  },
};

test('create saves the order and logs one CREATE entry', () => {
  const { store, auditLog } = setup();
  store.create(sampleOrder(), SESSION_ID);

  assert.deepEqual(store.list(MANAGER).orders, [sampleOrder()]);
  const entries = auditLog.readAll();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'CREATE');
  assert.equal(entries[0].actorType, 'CUSTOMER');
  assert.equal(entries[0].actorId, SESSION_ID);
  assert.equal(entries[0].entityId, 'order-1');
  assert.equal(entries[0].before, null);
  assert.deepEqual(entries[0].after, sampleOrder());
});

test('updateStatus logs one STATUS_CHANGE with only the changed field', () => {
  const { store, auditLog } = setup();
  store.create(sampleOrder(), SESSION_ID);

  const result = store.updateStatus('order-1', 'PREPARING', MANAGER);

  assert.equal(result.order.status, 'PREPARING');
  assert.equal(store.list(MANAGER).orders[0].status, 'PREPARING');
  const entry = auditLog.readAll()[1];
  assert.equal(entry.action, 'STATUS_CHANGE');
  assert.equal(entry.actorType, 'STAFF');
  assert.equal(entry.actorId, 'maria');
  assert.deepEqual(entry.before, { status: 'NEW' });
  assert.deepEqual(entry.after, { status: 'PREPARING' });
});

test('rejected status changes write nothing', () => {
  const { store, auditLog } = setup();
  store.create(sampleOrder(), SESSION_ID);

  assert.deepEqual(store.updateStatus('missing', 'PREPARING', MANAGER), { error: 'order_not_found' });
  assert.deepEqual(store.updateStatus('order-1', 'READY', MANAGER), { error: 'invalid_transition' });
  assert.equal(store.list(MANAGER).orders[0].status, 'NEW');
  assert.equal(auditLog.readAll().length, 1);
});

test('a failed audit write rolls back order creation', () => {
  const { ordersPath } = setup();
  fs.writeFileSync(ordersPath, JSON.stringify([sampleOrder('existing')], null, 2));
  const before = fs.readFileSync(ordersPath, 'utf-8');
  const store = createOrderStore(ordersPath, failingAuditLog);

  assert.throws(() => store.create(sampleOrder('new'), SESSION_ID), /disk full/);
  assert.equal(fs.readFileSync(ordersPath, 'utf-8'), before);
});

test('a failed audit write rolls back a status change', () => {
  const { ordersPath, store } = setup();
  store.create(sampleOrder(), SESSION_ID);
  const before = fs.readFileSync(ordersPath, 'utf-8');

  const failingStore = createOrderStore(ordersPath, failingAuditLog);
  assert.throws(() => failingStore.updateStatus('order-1', 'PREPARING', MANAGER), /disk full/);
  assert.equal(fs.readFileSync(ordersPath, 'utf-8'), before);
});

test('cancel keeps the order, records the reason, and logs one CANCEL entry', () => {
  const { store, auditLog } = setup();
  store.create(sampleOrder(), SESSION_ID);
  store.updateStatus('order-1', 'PREPARING', MANAGER);

  const result = store.cancel('order-1', 'Customer called to cancel', MANAGER);

  const [saved] = store.list(MANAGER).orders;
  assert.equal(result.order.status, 'CANCELLED');
  assert.equal(saved.status, 'CANCELLED');
  assert.equal(saved.cancelReason, 'Customer called to cancel');
  assert.ok(!Number.isNaN(Date.parse(saved.cancelledAt)));
  const entry = auditLog.readAll()[2];
  assert.equal(entry.action, 'CANCEL');
  assert.equal(entry.actorId, 'maria');
  assert.equal(entry.reason, 'Customer called to cancel');
  assert.deepEqual(entry.before, { status: 'PREPARING' });
  assert.deepEqual(entry.after, { status: 'CANCELLED' });
});

test('completed or already-cancelled orders cannot be cancelled', () => {
  const { store, auditLog } = setup();
  store.create({ ...sampleOrder('done'), status: 'COMPLETED' }, SESSION_ID);
  store.create(sampleOrder('twice'), SESSION_ID);
  store.cancel('twice', 'Out of oat milk today', MANAGER);

  assert.deepEqual(store.cancel('done', 'Too late to cancel', MANAGER), { error: 'invalid_transition' });
  assert.deepEqual(store.cancel('twice', 'Second cancel attempt', MANAGER), { error: 'invalid_transition' });
  assert.deepEqual(store.cancel('missing', 'No such order here', MANAGER), { error: 'order_not_found' });
  assert.equal(auditLog.readAll().length, 3);
});

test('a cancelled order cannot be moved back into the status flow', () => {
  const { store } = setup();
  store.create(sampleOrder(), SESSION_ID);
  store.cancel('order-1', 'Customer called to cancel', MANAGER);

  for (const status of ['NEW', 'PREPARING', 'READY', 'COMPLETED']) {
    assert.deepEqual(store.updateStatus('order-1', status, MANAGER), { error: 'invalid_transition' });
  }
  assert.equal(store.list(MANAGER).orders[0].status, 'CANCELLED');
});

test('a failed audit write rolls back a cancel', () => {
  const { ordersPath, store } = setup();
  store.create(sampleOrder(), SESSION_ID);
  const before = fs.readFileSync(ordersPath, 'utf-8');

  const failingStore = createOrderStore(ordersPath, failingAuditLog);
  assert.throws(() => failingStore.cancel('order-1', 'Customer called to cancel', MANAGER), /disk full/);
  assert.equal(fs.readFileSync(ordersPath, 'utf-8'), before);
});

test('history returns only that order\'s entries, newest first', () => {
  const { store } = setup();
  store.create(sampleOrder('order-1'), SESSION_ID);
  store.create(sampleOrder('order-2'), SESSION_ID);
  store.updateStatus('order-1', 'PREPARING', MANAGER);
  store.cancel('order-1', 'Customer called to cancel', MANAGER);

  const { entries } = store.history('order-1', MANAGER);
  assert.deepEqual(entries.map((e) => e.action), ['CANCEL', 'STATUS_CHANGE', 'CREATE']);
  assert.ok(entries.every((e) => e.entityId === 'order-1'));
  assert.deepEqual(store.history('missing', MANAGER), { error: 'order_not_found' });
});

test('a barista can view and advance orders but not cancel them', () => {
  const { store, auditLog } = setup();
  store.create(sampleOrder(), SESSION_ID);

  assert.equal(store.list(BARISTA).orders.length, 1);
  assert.equal(store.history('order-1', BARISTA).entries.length, 1);
  assert.equal(store.updateStatus('order-1', 'PREPARING', BARISTA).order.status, 'PREPARING');
  assert.deepEqual(store.cancel('order-1', 'Customer called to cancel', BARISTA), { error: 'forbidden' });

  assert.equal(store.list(MANAGER).orders[0].status, 'PREPARING');
  assert.deepEqual(auditLog.readAll().map((e) => e.action), ['CREATE', 'STATUS_CHANGE']);
});

test('a manager can view, advance, and cancel orders', () => {
  const { store } = setup();
  store.create(sampleOrder(), SESSION_ID);

  assert.equal(store.list(MANAGER).orders.length, 1);
  assert.equal(store.history('order-1', MANAGER).entries.length, 1);
  assert.equal(store.updateStatus('order-1', 'PREPARING', MANAGER).order.status, 'PREPARING');
  assert.equal(store.cancel('order-1', 'Customer called to cancel', MANAGER).order.status, 'CANCELLED');
});

test('an unknown or missing role is denied everything and writes nothing', () => {
  const { store, auditLog } = setup();
  store.create(sampleOrder(), SESSION_ID);

  for (const staff of [{ username: 'x', role: 'OWNER' }, { username: 'x', role: undefined }, { username: 'x', role: 'toString' }]) {
    assert.deepEqual(store.list(staff), { error: 'forbidden' });
    assert.deepEqual(store.history('order-1', staff), { error: 'forbidden' });
    assert.deepEqual(store.updateStatus('order-1', 'PREPARING', staff), { error: 'forbidden' });
    assert.deepEqual(store.cancel('order-1', 'Customer called to cancel', staff), { error: 'forbidden' });
  }
  assert.equal(auditLog.readAll().length, 1);
});

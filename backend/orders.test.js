const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAuditLog } = require('./audit');
const { createOrderStore } = require('./orders');

const SESSION_ID = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';

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

  assert.deepEqual(store.readAll(), [sampleOrder()]);
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

  const result = store.updateStatus('order-1', 'PREPARING');

  assert.equal(result.order.status, 'PREPARING');
  assert.equal(store.readAll()[0].status, 'PREPARING');
  const entry = auditLog.readAll()[1];
  assert.equal(entry.action, 'STATUS_CHANGE');
  assert.equal(entry.actorType, 'STAFF');
  assert.deepEqual(entry.before, { status: 'NEW' });
  assert.deepEqual(entry.after, { status: 'PREPARING' });
});

test('rejected status changes write nothing', () => {
  const { store, auditLog } = setup();
  store.create(sampleOrder(), SESSION_ID);

  assert.deepEqual(store.updateStatus('missing', 'PREPARING'), { error: 'order_not_found' });
  assert.deepEqual(store.updateStatus('order-1', 'READY'), { error: 'invalid_transition' });
  assert.equal(store.readAll()[0].status, 'NEW');
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
  assert.throws(() => failingStore.updateStatus('order-1', 'PREPARING'), /disk full/);
  assert.equal(fs.readFileSync(ordersPath, 'utf-8'), before);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAuditLog } = require('./audit');

function tempLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentledger-audit-'));
  return path.join(dir, 'audit-log.jsonl');
}

const statusChange = {
  actorType: 'STAFF',
  actorId: null,
  action: 'STATUS_CHANGE',
  entityType: 'STAFF',
  entityId: 'staff-1',
  before: { status: 'NEW' },
  after: { status: 'PREPARING' },
  reason: null,
};

test('readAll returns an empty list when nothing has been logged', () => {
  assert.deepEqual(createAuditLog(tempLogPath()).readAll(), []);
});

test('append adds an id and timestamp and entries read back in order', () => {
  const log = createAuditLog(tempLogPath());
  const first = log.append(statusChange);
  const second = log.append({ ...statusChange, before: { status: 'PREPARING' }, after: { status: 'READY' } });

  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(first.createdAt)));
  assert.deepEqual(log.readAll(), [first, second]);
});

test('appending never rewrites existing entries', () => {
  const filePath = tempLogPath();
  const log = createAuditLog(filePath);
  log.append(statusChange);
  const before = fs.readFileSync(filePath, 'utf-8');

  log.append({ ...statusChange, entityId: 'staff-2' });

  const after = fs.readFileSync(filePath, 'utf-8');
  assert.ok(after.startsWith(before));
  assert.equal(after.split('\n').filter(Boolean).length, 2);
});

test('the log exposes no way to update or delete entries', () => {
  assert.deepEqual(Object.keys(createAuditLog(tempLogPath())).sort(), ['append', 'readAll']);
});

test('mutating a read entry does not change the stored log', () => {
  const log = createAuditLog(tempLogPath());
  log.append(statusChange);
  log.readAll()[0].after.status = 'COMPLETED';
  assert.equal(log.readAll()[0].after.status, 'PREPARING');
});

test('invalid entries are rejected and nothing is written', () => {
  const filePath = tempLogPath();
  const log = createAuditLog(filePath);
  for (const bad of [
    { ...statusChange, action: 'DELETE' },
    { ...statusChange, actorType: 'ROBOT' },
    { ...statusChange, entityId: '' },
    { ...statusChange, id: 'forged-id' },
    { ...statusChange, reason: '' },
  ]) {
    assert.throws(() => log.append(bad));
  }
  assert.equal(fs.existsSync(filePath), false);
});

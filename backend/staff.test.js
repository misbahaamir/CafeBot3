const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStaffStore } = require('./staff');
const { createAuditLog } = require('./audit');

const NO_AUDIT = { append() {} };

const PASSWORD = 'correct horse battery';

function tempStaffPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentledger-staff-'));
  return path.join(dir, 'staff.json');
}

test('verify accepts the right password and rejects wrong ones', () => {
  const store = createStaffStore(tempStaffPath(), NO_AUDIT);
  store.add('manager1', PASSWORD, 'MANAGER');

  assert.deepEqual(store.verify('manager1', PASSWORD), { username: 'manager1', role: 'MANAGER' });
  assert.equal(store.verify('manager1', 'correct horse battery!'), null);
  assert.equal(store.verify('manager1', ''), null);
});

test('verify rejects unknown usernames, including when no staff file exists', () => {
  const filePath = tempStaffPath();
  assert.equal(createStaffStore(filePath, NO_AUDIT).verify('nobody', PASSWORD), null);

  createStaffStore(filePath, NO_AUDIT).add('manager1', PASSWORD, 'MANAGER');
  assert.equal(createStaffStore(filePath, NO_AUDIT).verify('nobody', PASSWORD), null);
});

test('the staff file never contains the plaintext password, and salts differ', () => {
  const filePath = tempStaffPath();
  const store = createStaffStore(filePath, NO_AUDIT);
  store.add('alice', PASSWORD, 'MANAGER');
  store.add('bob', PASSWORD, 'MANAGER');

  const raw = fs.readFileSync(filePath, 'utf-8');
  assert.ok(!raw.includes(PASSWORD));
  const [alice, bob] = JSON.parse(raw);
  assert.notEqual(alice.salt, bob.salt);
  assert.notEqual(alice.passwordHash, bob.passwordHash);
});

test('the staff file is readable by its owner only', { skip: process.platform === 'win32' }, () => {
  const filePath = tempStaffPath();
  createStaffStore(filePath, NO_AUDIT).add('manager1', PASSWORD, 'MANAGER');
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('add rejects weak passwords, bad usernames, and duplicates', () => {
  const store = createStaffStore(tempStaffPath(), NO_AUDIT);
  assert.throws(() => store.add('manager1', 'short', 'MANAGER'), /at least 12/);
  assert.throws(() => store.add('Bad Name', PASSWORD, 'MANAGER'), /Username/);
  assert.throws(() => store.add('ab', PASSWORD, 'MANAGER'), /Username/);
  store.add('manager1', PASSWORD, 'MANAGER');
  assert.throws(() => store.add('manager1', PASSWORD, 'MANAGER'), /already exists/);
});

test('add requires a known role and verify returns it', () => {
  const store = createStaffStore(tempStaffPath(), NO_AUDIT);
  assert.throws(() => store.add('owner', PASSWORD, 'OWNER'), /Role must be one of: ADMIN, MANAGER, BOOKKEEPER, ACCOUNTANT/);
  assert.throws(() => store.add('owner', PASSWORD), /Role must be one of/);
  store.add('maria', PASSWORD, 'MANAGER');
  assert.deepEqual(store.verify('maria', PASSWORD), { username: 'maria', role: 'MANAGER' });
});

test('creating an account is audited without the password hash, and undone if the audit write fails', () => {
  const filePath = tempStaffPath();
  const auditLog = createAuditLog(path.join(path.dirname(filePath), 'audit-log.jsonl'));
  createStaffStore(filePath, auditLog).add('maria', PASSWORD, 'MANAGER');
  const [entry] = auditLog.readAll();
  assert.deepEqual([entry.actorType, entry.action, entry.entityType, entry.entityId], ['SYSTEM', 'CREATE', 'STAFF', 'maria']);
  assert.deepEqual(entry.after, { username: 'maria', role: 'MANAGER' });

  const failing = { append: () => { throw new Error('disk full'); } };
  assert.throws(() => createStaffStore(filePath, failing).add('bob', PASSWORD, 'MANAGER'), /disk full/);
  assert.equal(createStaffStore(filePath, NO_AUDIT).verify('bob', PASSWORD), null);
  assert.ok(createStaffStore(filePath, NO_AUDIT).verify('maria', PASSWORD));
});

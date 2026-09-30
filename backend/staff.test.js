const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStaffStore } = require('./staff');

const PASSWORD = 'correct horse battery';

function tempStaffPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafebot-staff-'));
  return path.join(dir, 'staff.json');
}

test('verify accepts the right password and rejects wrong ones', () => {
  const store = createStaffStore(tempStaffPath());
  store.add('barista', PASSWORD, 'BARISTA');

  assert.deepEqual(store.verify('barista', PASSWORD), { username: 'barista', role: 'BARISTA' });
  assert.equal(store.verify('barista', 'correct horse battery!'), null);
  assert.equal(store.verify('barista', ''), null);
});

test('verify rejects unknown usernames, including when no staff file exists', () => {
  const filePath = tempStaffPath();
  assert.equal(createStaffStore(filePath).verify('nobody', PASSWORD), null);

  createStaffStore(filePath).add('barista', PASSWORD, 'BARISTA');
  assert.equal(createStaffStore(filePath).verify('nobody', PASSWORD), null);
});

test('the staff file never contains the plaintext password, and salts differ', () => {
  const filePath = tempStaffPath();
  const store = createStaffStore(filePath);
  store.add('alice', PASSWORD, 'BARISTA');
  store.add('bob', PASSWORD, 'BARISTA');

  const raw = fs.readFileSync(filePath, 'utf-8');
  assert.ok(!raw.includes(PASSWORD));
  const [alice, bob] = JSON.parse(raw);
  assert.notEqual(alice.salt, bob.salt);
  assert.notEqual(alice.passwordHash, bob.passwordHash);
});

test('the staff file is readable by its owner only', { skip: process.platform === 'win32' }, () => {
  const filePath = tempStaffPath();
  createStaffStore(filePath).add('barista', PASSWORD, 'BARISTA');
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('add rejects weak passwords, bad usernames, and duplicates', () => {
  const store = createStaffStore(tempStaffPath());
  assert.throws(() => store.add('barista', 'short', 'BARISTA'), /at least 12/);
  assert.throws(() => store.add('Bad Name', PASSWORD, 'BARISTA'), /Username/);
  assert.throws(() => store.add('ab', PASSWORD, 'BARISTA'), /Username/);
  store.add('barista', PASSWORD, 'BARISTA');
  assert.throws(() => store.add('barista', PASSWORD, 'BARISTA'), /already exists/);
});

test('add requires a known role and verify returns it', () => {
  const store = createStaffStore(tempStaffPath());
  assert.throws(() => store.add('owner', PASSWORD, 'OWNER'), /Role must be one of: MANAGER, BARISTA/);
  assert.throws(() => store.add('owner', PASSWORD), /Role must be one of/);
  store.add('maria', PASSWORD, 'MANAGER');
  assert.deepEqual(store.verify('maria', PASSWORD), { username: 'maria', role: 'MANAGER' });
});

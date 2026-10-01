const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('./write-file');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rentledger-write-'));
}

test('writes a new file and leaves no temporary file behind', () => {
  const dir = tempDir();
  const file = path.join(dir, 'income.json');
  writeFileAtomic(file, '[1]');
  assert.equal(fs.readFileSync(file, 'utf-8'), '[1]');
  assert.deepEqual(fs.readdirSync(dir), ['income.json']);
});

test('replaces an existing file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'income.json');
  fs.writeFileSync(file, '[1]');
  writeFileAtomic(file, '[1,2]');
  assert.equal(fs.readFileSync(file, 'utf-8'), '[1,2]');
  assert.deepEqual(fs.readdirSync(dir), ['income.json']);
});

test('applies the requested permissions', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  const file = path.join(dir, 'staff.json');
  fs.writeFileSync(file, '[]', { mode: 0o644 });
  writeFileAtomic(file, '[1]', { mode: 0o600 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a failed save leaves the target untouched and removes the temporary file', () => {
  const dir = tempDir();
  // A folder can't be replaced by a file, so the final rename fails after the
  // temporary file has been written.
  const target = path.join(dir, 'income.json');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'x');
  assert.throws(() => writeFileAtomic(target, '[1]'));
  assert.deepEqual(fs.readdirSync(dir), ['income.json']);
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf-8'), 'x');
});

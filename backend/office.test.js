const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadOffice } = require('./office');

const SAMPLE = path.join(__dirname, '..', 'data', 'sample', 'office.json');

function dirWith(office) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentledger-office-'));
  if (office) fs.writeFileSync(path.join(dir, 'office.json'), JSON.stringify(office));
  return dir;
}

test('the sample office file loads', () => {
  const office = loadOffice(dirWith(JSON.parse(fs.readFileSync(SAMPLE, 'utf-8'))));
  assert.equal(office.email, 'office@example.com');
});

test('a missing or invalid office file is refused with a clear message', () => {
  assert.throws(() => loadOffice(dirWith()), /Missing .*office\.json.*seed:sample/);
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf-8'));
  assert.throws(() => loadOffice(dirWith({ ...sample, email: 'nope' })), /Invalid office\.json at email/);
  assert.throws(() => loadOffice(dirWith({ ...sample, notes: 'x' })), /Invalid office\.json/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { loginBodySchema, validate } = require('./validation');

test('login: accepts a valid username and password', () => {
  const { data, error } = validate(loginBodySchema, { username: 'maria', password: 'correct horse battery' });
  assert.equal(error, undefined);
  assert.deepEqual(data, { username: 'maria', password: 'correct horse battery' });
});

test('login: rejects bad usernames, missing or oversized passwords, and unknown keys', () => {
  for (const body of [
    {},
    { username: 'Maria', password: 'x' },
    { username: 'maria' },
    { username: 'maria', password: '' },
    { username: 'maria', password: 'x'.repeat(201) },
    { username: 'maria', password: 'x', role: 'ADMIN' },
  ]) {
    assert.ok(validate(loginBodySchema, body).error, JSON.stringify(body));
  }
});

test('validate reports the failing path', () => {
  const { error } = validate(loginBodySchema, { username: 'maria', password: 5 });
  assert.equal(error.error, 'invalid_request');
  assert.equal(error.issues[0].path, 'password');
});

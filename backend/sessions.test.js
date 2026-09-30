const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionStore } = require('./sessions');

function clockedStore(ttlMs) {
  const clock = { now: 1000 };
  return { clock, store: createSessionStore({ ttlMs, now: () => clock.now }) };
}

test('a created session resolves to its username until it expires', () => {
  const { clock, store } = clockedStore(60000);
  const token = store.create('maria', 'MANAGER');

  assert.deepEqual(store.get(token), { username: 'maria', role: 'MANAGER' });
  clock.now += 59999;
  assert.deepEqual(store.get(token), { username: 'maria', role: 'MANAGER' });
  clock.now += 1;
  assert.equal(store.get(token), null);
});

test('tokens are long, random, and distinct', () => {
  const { store } = clockedStore(60000);
  const a = store.create('maria', 'MANAGER');
  const b = store.create('maria', 'MANAGER');
  assert.notEqual(a, b);
  assert.ok(a.length >= 43);
});

test('destroy ends a session; unknown or missing tokens resolve to null', () => {
  const { store } = clockedStore(60000);
  const token = store.create('maria', 'MANAGER');
  store.destroy(token);
  assert.equal(store.get(token), null);
  assert.equal(store.get('not-a-token'), null);
  assert.equal(store.get(null), null);
  assert.equal(store.get(undefined), null);
});

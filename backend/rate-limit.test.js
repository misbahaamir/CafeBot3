const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('./rate-limit');

function clockedLimiter(limit, windowMs) {
  const clock = { now: 1000 };
  return { clock, limiter: createRateLimiter({ limit, windowMs, now: () => clock.now }) };
}

test('allows up to the limit per window, then refuses until the window ends', () => {
  const { clock, limiter } = clockedLimiter(3, 60000);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(limiter.take('1.2.3.4'), { allowed: true });
  }
  assert.deepEqual(limiter.take('1.2.3.4'), { allowed: false, retryAfterMs: 60000 });

  clock.now += 59999;
  assert.deepEqual(limiter.take('1.2.3.4'), { allowed: false, retryAfterMs: 1 });
  clock.now += 1;
  assert.deepEqual(limiter.take('1.2.3.4'), { allowed: true });
});

test('keys are counted separately', () => {
  const { limiter } = clockedLimiter(1, 60000);
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, false);
  assert.equal(limiter.take('b').allowed, true);
});

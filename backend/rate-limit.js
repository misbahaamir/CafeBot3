// In-memory and per process: counts reset on restart and are not shared
// between server instances.
function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const windows = new Map();
  let nextSweepAt = 0;

  function take(key) {
    const t = now();
    // Drop finished windows so keys that stop sending don't accumulate forever.
    if (t >= nextSweepAt) {
      for (const [k, w] of windows) {
        if (t >= w.resetAt) windows.delete(k);
      }
      nextSweepAt = t + windowMs;
    }

    const current = windows.get(key);
    if (!current || t >= current.resetAt) {
      windows.set(key, { count: 1, resetAt: t + windowMs });
      return { allowed: true };
    }
    if (current.count >= limit) {
      return { allowed: false, retryAfterMs: current.resetAt - t };
    }
    current.count += 1;
    return { allowed: true };
  }

  return { take };
}

module.exports = { createRateLimiter };

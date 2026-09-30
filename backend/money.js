function assertCents(cents) {
  if (!Number.isInteger(cents)) {
    throw new TypeError(`Expected integer cents, got ${cents}`);
  }
}

function formatCents(cents) {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// Rounds half up. Integer-only math avoids float drift (e.g. 1.005 * 100).
function applyRate(cents, basisPoints) {
  assertCents(cents);
  if (cents < 0) {
    throw new RangeError(`Expected non-negative cents, got ${cents}`);
  }
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new TypeError(`Expected non-negative integer basis points, got ${basisPoints}`);
  }
  return Math.floor((cents * basisPoints + 5000) / 10000);
}

// Anything shown to the language model goes through this, so it only ever sees
// "$4.50" and never has to interpret a raw cents value like 450.
function withDisplayAmounts(value) {
  if (Array.isArray(value)) {
    return value.map(withDisplayAmounts);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key.endsWith('Cents') && Number.isInteger(v)) {
        out[key.slice(0, -'Cents'.length)] = formatCents(v);
      } else {
        out[key] = withDisplayAmounts(v);
      }
    }
    return out;
  }
  return value;
}

module.exports = { formatCents, applyRate, withDisplayAmounts };

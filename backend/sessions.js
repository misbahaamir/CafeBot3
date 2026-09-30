const crypto = require('crypto');

// In-memory only: everyone signs in again after a server restart.
function createSessionStore({ ttlMs, now = Date.now }) {
  const sessions = new Map();

  function create(username) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { username, expiresAt: now() + ttlMs });
    return token;
  }

  function get(token) {
    const session = token && sessions.get(token);
    if (!session) {
      return null;
    }
    if (now() >= session.expiresAt) {
      sessions.delete(token);
      return null;
    }
    return { username: session.username };
  }

  function destroy(token) {
    sessions.delete(token);
  }

  return { create, get, destroy };
}

module.exports = { createSessionStore };

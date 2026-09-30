const fs = require('fs');
const crypto = require('crypto');

const KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 12;
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, KEY_LENGTH);
}

// Hashed once at startup so a login for an unknown username costs the same
// scrypt call as a real one, and response time doesn't reveal which exist.
const DUMMY_SALT = crypto.randomBytes(16);
const DUMMY_HASH = hashPassword('not-a-real-password', DUMMY_SALT);

function createStaffStore(filePath) {
  function readAll() {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  function add(username, password) {
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error('Username must be 3-32 characters: lowercase letters, digits, "_", "." or "-".');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    const staff = readAll();
    if (staff.some((s) => s.username === username)) {
      throw new Error(`Staff member "${username}" already exists.`);
    }

    const salt = crypto.randomBytes(16);
    staff.push({
      username,
      salt: salt.toString('base64'),
      passwordHash: hashPassword(password, salt).toString('base64'),
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(filePath, JSON.stringify(staff, null, 2), { mode: 0o600 });
    return { username };
  }

  function verify(username, password) {
    const member = readAll().find((s) => s.username === username);
    const salt = member ? Buffer.from(member.salt, 'base64') : DUMMY_SALT;
    const expected = member ? Buffer.from(member.passwordHash, 'base64') : DUMMY_HASH;
    const matches = crypto.timingSafeEqual(hashPassword(password, salt), expected);
    return member && matches ? { username: member.username } : null;
  }

  return { add, verify };
}

module.exports = { createStaffStore, USERNAME_PATTERN };

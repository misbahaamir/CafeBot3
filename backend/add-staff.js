const path = require('path');
const readline = require('readline');
const { createStaffStore } = require('./staff');
const { createAuditLog } = require('./audit');
const { ROLES } = require('./permissions');

const [username, role] = process.argv.slice(2);
if (!username || !ROLES.includes(role)) {
  console.error(`Usage: npm run staff:add -- <username> <${ROLES.join('|')}>   (password is read from stdin)`);
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.question('Password (at least 12 characters; visible as you type): ', (password) => {
  rl.close();
  try {
    const dataDir = path.join(__dirname, '..', 'data');
    const auditLog = createAuditLog(path.join(dataDir, 'audit-log.jsonl'));
    createStaffStore(path.join(dataDir, 'staff.json'), auditLog).add(username, password, role);
    console.log(`\nAdded ${role} "${username}".`);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
});

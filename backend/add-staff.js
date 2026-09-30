const path = require('path');
const readline = require('readline');
const { createStaffStore } = require('./staff');
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
    createStaffStore(path.join(__dirname, '..', 'data', 'staff.json')).add(username, password, role);
    console.log(`\nAdded ${role} "${username}".`);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
});

const path = require('path');
const readline = require('readline');
const { createStaffStore } = require('./staff');

const username = process.argv[2];
if (!username) {
  console.error('Usage: npm run staff:add -- <username>   (password is read from stdin)');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.question('Password (at least 12 characters; visible as you type): ', (password) => {
  rl.close();
  try {
    createStaffStore(path.join(__dirname, '..', 'data', 'staff.json')).add(username, password);
    console.log(`\nAdded staff member "${username}".`);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
});

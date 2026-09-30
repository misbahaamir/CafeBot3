const fs = require('fs');
const path = require('path');

const sampleDir = path.join(__dirname, '..', 'data', 'sample');
const dataDir = path.join(__dirname, '..', 'data');

// Never overwrites: real tenant data may already be in these files.
for (const file of fs.readdirSync(sampleDir)) {
  const target = path.join(dataDir, file);
  if (fs.existsSync(target)) {
    console.log(`Skipped ${file} (already exists)`);
    continue;
  }
  fs.copyFileSync(path.join(sampleDir, file), target);
  console.log(`Created data/${file} from sample data`);
}

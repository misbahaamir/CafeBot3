const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Writing straight over a data file leaves it truncated or half-written if the
// process dies mid-write. Instead the contents go to a temporary file in the
// same folder, are flushed to disk, and then renamed over the target: a rename
// within one folder swaps the file in one step, so readers see either the old
// contents or the new, never a mix.
function writeFileAtomic(filePath, contents, { mode = 0o644 } = {}) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(tempPath, 'wx', mode);
    try {
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

module.exports = { writeFileAtomic };

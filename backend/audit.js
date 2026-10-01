const fs = require('fs');
const crypto = require('crypto');
const { z } = require('zod');

const entrySchema = z
  .object({
    actorType: z.enum(['PUBLIC', 'STAFF', 'SYSTEM']),
    actorId: z.string().min(1).nullable(),
    action: z.enum(['CREATE', 'STATUS_CHANGE', 'CANCEL', 'VOID', 'LOGIN']),
    entityType: z.enum(['STAFF', 'MAINTENANCE_REQUEST', 'VIEWING_REQUEST', 'INCOME', 'EXPENSE']),
    entityId: z.string().min(1),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    reason: z.string().min(1).nullable(),
  })
  .strict();

// Deliberately exposes no update or delete: the only write is an append in
// 'a' mode, so existing entries are never rewritten by the app. The file is
// still editable by hand on disk; that is outside what the app can enforce.
function createAuditLog(filePath) {
  // A write cut short (crash, full disk) leaves a last line with no newline.
  // The damaged line is kept as it is, but the next entry must start on its own
  // line or it would be glued onto it and lost too.
  function endsMidLine() {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
    try {
      const { size } = fs.fstatSync(fd);
      if (size === 0) return false;
      const lastByte = Buffer.alloc(1);
      fs.readSync(fd, lastByte, 0, 1, size - 1);
      return lastByte[0] !== 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  }

  function append(entry) {
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...entrySchema.parse(entry),
    };
    const separator = endsMidLine() ? '\n' : '';
    fs.appendFileSync(filePath, `${separator}${JSON.stringify(record)}\n`, { flag: 'a' });
    return record;
  }

  function readAll() {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    return fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  }

  return { append, readAll };
}

module.exports = { createAuditLog };

const fs = require('fs');
const crypto = require('crypto');
const { z } = require('zod');

const entrySchema = z
  .object({
    actorType: z.enum(['CUSTOMER', 'STAFF', 'SYSTEM']),
    actorId: z.string().min(1).nullable(),
    action: z.enum(['CREATE', 'STATUS_CHANGE', 'CANCEL', 'LOGIN']),
    entityType: z.enum(['STAFF']),
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
  function append(entry) {
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...entrySchema.parse(entry),
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { flag: 'a' });
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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');

const contactFields = {
  name: z.string().trim().min(1).max(100),
  email: z.email(),
  phone: z.string().trim().min(1).max(30).optional(),
};

const maintenanceInputSchema = z
  .object({
    ...contactFields,
    // As the requester typed it: the public assistant cannot verify who lives
    // where, so staff match the request to a unit themselves.
    address: z.string().trim().min(1).max(200),
    category: z.enum(['PLUMBING', 'ELECTRICAL', 'HEATING_COOLING', 'APPLIANCE', 'PEST', 'LOCK_OR_DOOR', 'OTHER']),
    urgency: z.enum(['URGENT', 'ROUTINE']),
    description: z.string().trim().min(10).max(2000),
  })
  .strict();

const viewingInputSchema = z
  .object({
    ...contactFields,
    unitId: z.string().regex(/^[a-z0-9-]{1,40}$/),
    preferredTimes: z.string().trim().min(1).max(300),
  })
  .strict();

const KINDS = {
  maintenance: { file: 'maintenance-requests.json', entityType: 'MAINTENANCE_REQUEST' },
  viewing: { file: 'viewing-requests.json', entityType: 'VIEWING_REQUEST' },
};

function createRequestStore(dataDir, auditLog, { rentalStore }) {
  function readAll(kind) {
    const filePath = path.join(dataDir, KINDS[kind].file);
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : [];
  }

  // JSON files have no transactions: if the audit entry can't be written, the
  // previous file contents are put back so no request is left unlogged.
  function create(kind, fields) {
    const filePath = path.join(dataDir, KINDS[kind].file);
    const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    const request = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'NEW', ...fields };
    fs.writeFileSync(filePath, JSON.stringify([...readAll(kind), request], null, 2));
    try {
      auditLog.append({
        actorType: 'PUBLIC',
        actorId: null,
        action: 'CREATE',
        entityType: KINDS[kind].entityType,
        entityId: request.id,
        before: null,
        after: request,
        reason: null,
      });
    } catch (err) {
      if (previous === null) fs.unlinkSync(filePath);
      else fs.writeFileSync(filePath, previous);
      throw err;
    }
    return request;
  }

  function createMaintenance(fields) {
    return create('maintenance', fields);
  }

  function createViewing(fields) {
    if (!rentalStore.listings().some((listing) => listing.unitId === fields.unitId)) {
      return { error: 'unit_not_listed' };
    }
    return create('viewing', fields);
  }

  return { readAll, createMaintenance, createViewing };
}

module.exports = { createRequestStore, maintenanceInputSchema, viewingInputSchema };

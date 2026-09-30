const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const { can } = require('./permissions');

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
  maintenance: {
    file: 'maintenance-requests.json',
    entityType: 'MAINTENANCE_REQUEST',
    statusFlow: ['NEW', 'IN_PROGRESS', 'COMPLETED'],
  },
  viewing: {
    file: 'viewing-requests.json',
    entityType: 'VIEWING_REQUEST',
    statusFlow: ['NEW', 'SCHEDULED', 'COMPLETED'],
  },
};
const CANCELLED = 'CANCELLED';
const FINAL_STATUSES = ['COMPLETED', CANCELLED];

const requestParamsSchema = z.object({ kind: z.enum(Object.keys(KINDS)), id: z.uuid() });
const statusBodySchema = z
  .object({ status: z.enum([...new Set(Object.values(KINDS).flatMap((k) => k.statusFlow))]) })
  .strict();
const cancelBodySchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();

function createRequestStore(dataDir, auditLog, { rentalStore }) {
  function readAll(kind) {
    const filePath = path.join(dataDir, KINDS[kind].file);
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : [];
  }

  // JSON files have no transactions: if the audit entry can't be written, the
  // previous file contents are put back so no change is left unlogged.
  function commit(kind, requests, auditEntry) {
    const filePath = path.join(dataDir, KINDS[kind].file);
    const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    fs.writeFileSync(filePath, JSON.stringify(requests, null, 2));
    try {
      auditLog.append({ entityType: KINDS[kind].entityType, ...auditEntry });
    } catch (err) {
      if (previous === null) fs.unlinkSync(filePath);
      else fs.writeFileSync(filePath, previous);
      throw err;
    }
  }

  function create(kind, fields) {
    const request = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'NEW', ...fields };
    commit(kind, [...readAll(kind), request], {
      actorType: 'PUBLIC',
      actorId: null,
      action: 'CREATE',
      entityId: request.id,
      before: null,
      after: request,
      reason: null,
    });
    return request;
  }

  function list(staff) {
    if (!can(staff.role, 'requests:view')) {
      return { error: 'forbidden' };
    }
    const { properties, units } = rentalStore.load();
    const addresses = new Map(properties.map((p) => [p.id, p.address]));
    const unitNames = new Map(units.map((u) => [u.id, `${addresses.get(u.propertyId)}, ${u.label}`]));
    const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt);
    return {
      maintenance: readAll('maintenance').sort(newestFirst),
      viewing: readAll('viewing')
        .sort(newestFirst)
        .map((request) => ({ ...request, unitName: unitNames.get(request.unitId) ?? request.unitId })),
    };
  }

  // Shared by status changes and cancellations: finds an open request the
  // staff member may change.
  function findOpen(kind, id, staff) {
    if (!can(staff.role, 'requests:manage')) {
      return { error: 'forbidden' };
    }
    const requests = readAll(kind);
    const request = requests.find((r) => r.id === id);
    if (!request) {
      return { error: 'request_not_found' };
    }
    if (FINAL_STATUSES.includes(request.status)) {
      return { error: 'invalid_transition' };
    }
    return { requests, request };
  }

  // Status only moves one step forward; going back or skipping ahead would
  // make the audit trail misleading.
  function updateStatus(kind, id, status, staff) {
    const found = findOpen(kind, id, staff);
    if (found.error) return found;
    const { requests, request } = found;
    const flow = KINDS[kind].statusFlow;
    if (flow.indexOf(status) !== flow.indexOf(request.status) + 1) {
      return { error: 'invalid_transition' };
    }
    const previousStatus = request.status;
    request.status = status;
    commit(kind, requests, {
      actorType: 'STAFF',
      actorId: staff.username,
      action: 'STATUS_CHANGE',
      entityId: id,
      before: { status: previousStatus },
      after: { status },
      reason: null,
    });
    return { request };
  }

  function cancel(kind, id, reason, staff) {
    const found = findOpen(kind, id, staff);
    if (found.error) return found;
    const { requests, request } = found;
    const previousStatus = request.status;
    request.status = CANCELLED;
    request.cancelReason = reason;
    commit(kind, requests, {
      actorType: 'STAFF',
      actorId: staff.username,
      action: 'CANCEL',
      entityId: id,
      before: { status: previousStatus },
      after: { status: CANCELLED },
      reason,
    });
    return { request };
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

  return { readAll, createMaintenance, createViewing, list, updateStatus, cancel };
}

module.exports = {
  createRequestStore,
  maintenanceInputSchema,
  viewingInputSchema,
  requestParamsSchema,
  statusBodySchema,
  cancelBodySchema,
};

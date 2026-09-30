const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { can } = require('./permissions');

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

const idSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
const dateSchema = z.iso.date();
const centsSchema = z.number().int().min(0);

const propertySchema = z
  .object({
    id: idSchema,
    address: z.string().min(1).max(200),
    city: z.string().min(1).max(100),
    province: z.enum(PROVINCES),
    postalCode: z.string().regex(/^[A-Z]\d[A-Z] \d[A-Z]\d$/),
    useType: z.enum(['RESIDENTIAL', 'COMMERCIAL', 'MIXED']),
    rentalUsePercent: z.number().int().min(0).max(100),
    acquiredOn: dateSchema,
    disposedOn: dateSchema.nullable(),
  })
  .strict();

const unitSchema = z
  .object({
    id: idSchema,
    propertyId: idSchema,
    label: z.string().min(1).max(100),
    bedrooms: z.number().int().min(0).max(20),
    bathrooms: z.number().multipleOf(0.5).min(0).max(20),
    defaultRentCents: centsSchema,
    // null means the unit is not advertised to prospective tenants.
    listing: z
      .object({
        description: z.string().min(1).max(1000),
        availableFrom: dateSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

const tenantSchema = z
  .object({
    id: idSchema,
    fullName: z.string().min(1).max(200),
    email: z.email(),
    phone: z.string().min(1).max(30),
  })
  .strict();

const leaseSchema = z
  .object({
    id: idSchema,
    unitId: idSchema,
    tenantIds: z.array(idSchema).min(1),
    startDate: dateSchema,
    // null means the lease continues with no fixed end (month to month).
    endDate: dateSchema.nullable(),
    rentCents: centsSchema,
    // Capped at 28 so the due day exists in every month.
    rentDueDay: z.number().int().min(1).max(28),
    includedUtilities: z.array(z.string().min(1).max(50)).max(10),
  })
  .strict();

const FILES = {
  properties: propertySchema,
  units: unitSchema,
  tenants: tenantSchema,
  leases: leaseSchema,
};

function readFile(dataDir, name) {
  const filePath = path.join(dataDir, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. For sample data, run: npm run seed:sample`);
  }
  const parsed = z.array(FILES[name]).safeParse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid ${name}.json at ${issue.path.join('.')}: ${issue.message}`);
  }
  return parsed.data;
}

function assertUniqueIds(name, records) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.id)) throw new Error(`Duplicate id "${record.id}" in ${name}.json`);
    seen.add(record.id);
  }
}

// Dates are YYYY-MM-DD strings, so they compare correctly as strings.
function leaseCovers(lease, date) {
  return lease.startDate <= date && (lease.endDate === null || date <= lease.endDate);
}

function leasesOverlap(a, b) {
  const aEnd = a.endDate ?? '9999-12-31';
  const bEnd = b.endDate ?? '9999-12-31';
  return a.startDate <= bEnd && b.startDate <= aEnd;
}

function assertConsistent({ properties, units, tenants, leases }) {
  for (const [name, records] of Object.entries({ properties, units, tenants, leases })) {
    assertUniqueIds(name, records);
  }
  const propertyIds = new Set(properties.map((p) => p.id));
  const unitIds = new Set(units.map((u) => u.id));
  const tenantIds = new Set(tenants.map((t) => t.id));

  for (const unit of units) {
    if (!propertyIds.has(unit.propertyId)) {
      throw new Error(`Unit "${unit.id}" refers to unknown property "${unit.propertyId}"`);
    }
  }
  for (const lease of leases) {
    if (!unitIds.has(lease.unitId)) {
      throw new Error(`Lease "${lease.id}" refers to unknown unit "${lease.unitId}"`);
    }
    for (const tenantId of lease.tenantIds) {
      if (!tenantIds.has(tenantId)) {
        throw new Error(`Lease "${lease.id}" refers to unknown tenant "${tenantId}"`);
      }
    }
    if (lease.endDate !== null && lease.endDate < lease.startDate) {
      throw new Error(`Lease "${lease.id}" ends before it starts`);
    }
    const clash = leases.find((other) => other !== lease && other.unitId === lease.unitId && leasesOverlap(lease, other));
    if (clash) {
      throw new Error(`Leases "${lease.id}" and "${clash.id}" overlap on unit "${lease.unitId}"`);
    }
  }
}

function createRentalStore(dataDir, { today }) {
  // Read on every call so hand edits to the data files apply without a restart.
  function load() {
    const data = {};
    for (const name of Object.keys(FILES)) {
      data[name] = readFile(dataDir, name);
    }
    assertConsistent(data);
    return data;
  }

  function overview(staff) {
    if (!can(staff.role, 'properties:view')) {
      return { error: 'forbidden' };
    }
    const { properties, units, tenants, leases } = load();
    const date = today();
    const tenantNames = new Map(tenants.map((t) => [t.id, t.fullName]));

    return {
      date,
      properties: properties.map((property) => ({
        ...property,
        units: units
          .filter((unit) => unit.propertyId === property.id)
          .map((unit) => {
            const lease = leases.find((l) => l.unitId === unit.id && leaseCovers(l, date));
            return {
              ...unit,
              currentLease: lease
                ? { ...lease, tenantNames: lease.tenantIds.map((id) => tenantNames.get(id)) }
                : null,
            };
          }),
      })),
    };
  }

  return { load, overview };
}

module.exports = { createRentalStore };

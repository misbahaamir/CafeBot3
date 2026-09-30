const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const officeSchema = z
  .object({
    companyName: z.string().min(1).max(200),
    phone: z.string().min(1).max(30),
    email: z.email(),
    officeHours: z.string().min(1).max(200),
    // null when the company has no after-hours line; the assistant then only
    // points to 911 for emergencies.
    emergencyMaintenancePhone: z.string().min(1).max(30).nullable(),
    faqs: z
      .array(
        z
          .object({
            question: z.string().min(1).max(200),
            answer: z.string().min(1).max(1000),
          })
          .strict()
      )
      .max(50),
  })
  .strict();

// Read on every call so edits to office.json apply without a restart.
function loadOffice(dataDir) {
  const filePath = path.join(dataDir, 'office.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. For sample data, run: npm run seed:sample`);
  }
  const parsed = officeSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid office.json at ${issue.path.join('.')}: ${issue.message}`);
  }
  return parsed.data;
}

module.exports = { loadOffice };

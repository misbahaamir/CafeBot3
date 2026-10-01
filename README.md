# RentLedger

A rental property management web app for a Canadian property management
company: properties, units, tenants, and leases, with staff roles and an
append-only audit log. RentLedger prepares records for an accountant; it does
not file anything with the CRA.

## Project Structure

- `frontend/` — public page, staff sign-in, and staff dashboard
- `backend/` — Express server and business logic
- `data/` — data files (`data/sample/` holds fictional sample data)
- `prompts/` — prompt templates

## Setup

1. Copy `.env.example` to `.env`. Set `ANTHROPIC_API_KEY` to a real key, and `TIME_ZONE` to the IANA time zone the business runs in (default `America/Toronto`); lease dates are compared against today's date in that zone.
2. Install backend dependencies: `cd backend && npm install`
3. Load the fictional sample data: `npm run seed:sample`. This creates `data/properties.json`, `data/units.json`, `data/tenants.json`, `data/leases.json`, and `data/office.json` only if they don't already exist. These files hold tenant personal data and company details and are not committed. Edit `data/office.json` with your real contact details, emergency maintenance line (or `null`), and FAQs: the public chat assistant answers general questions only from this file. The server checks them at startup and refuses to start if any is missing, invalid, or inconsistent (for example, two leases overlapping on one unit).
4. Start the server: `npm start` (serves the site and API on the `PORT` from `.env`, default `3000`).
5. Create a staff account: `npm run staff:add -- <username> <ADMIN|MANAGER|BOOKKEEPER|ACCOUNTANT>`, then enter a password of at least 12 characters. Sign in at `/login.html` to see the property overview and, for ADMIN and MANAGER, incoming requests. Permissions are defined in `backend/permissions.js` and enforced by the server: every role can view properties; only ADMIN and MANAGER can view and manage maintenance and viewing requests; ADMIN, MANAGER, and BOOKKEEPER can record and void rent and expenses, and ACCOUNTANT can view them. Accounts are stored with hashed passwords in `data/staff.json` (not committed); sign-in sessions are kept in memory, so staff sign in again after a server restart.
6. Run the tests: `npm test`

## Public chat assistant

The public page has a chat assistant (`POST /api/chat`, prompt in `prompts/tenant-assistant.md`) for tenants and prospective tenants. It can list advertised vacancies, take viewing requests for listed units, and take maintenance requests. It has no access to tenant, lease, or payment records, so it cannot answer questions about a person's own lease or rent; it refers those to the office. Requests are saved to `data/maintenance-requests.json` and `data/viewing-requests.json` (not committed) and written to the audit log. Staff move them forward one step at a time (maintenance: NEW → IN_PROGRESS → COMPLETED; viewings: NEW → SCHEDULED → COMPLETED) or cancel them with a reason; requests are never deleted, and every change is audited. Each visitor (by IP address) can send 20 chat messages a minute and submit 5 requests an hour.

## Rent and expenses

Staff record rent and other income, and expenses, on the "Rent & expenses" page (`ledger.html`). Entries are saved to `data/income.json` and `data/expenses.json` (not committed). Amounts are stored as integer cents in CAD, and totals are computed by the server; voided entries stay listed but are left out of totals. Entries are never deleted: they are voided with a reason, and every create and void is written to the audit log.

Expense categories (`backend/categories.js`) follow the expense lines of CRA form T776, checked against canada.ca on 2026-09-30. Capital items and non-deductible items (mortgage principal, land transfer tax, CRA penalties, the owner's own labour) are kept apart from current expenses. The category mapping must be reviewed by a CPA before production use.

The page also has an assistant: a staff member describes a transaction in plain words ("Priya paid $1,750 rent today"), the assistant fills in the form (prompt in `prompts/ledger-assistant.md`), and the staff member checks it and clicks Save. The assistant never saves anything and never calculates amounts. To match names to units it sends property addresses, unit labels, and current tenants' names (not their contact details) to the Claude API. Each staff member can request 30 drafts a minute.

## Testing the assistants against the live model

`npm test` uses stand-ins for the Claude API. To check how the real model behaves, run `npm run eval` (from `backend/`) with `ANTHROPIC_API_KEY` set. It runs the cases in `backend/eval/cases.js` for both assistants: vacancy answers, refusing to reveal tenant or lease details, prompt injection, emergencies, confirming before submitting a request, and drafting entries without calculating amounts. It uses only the fictional sample data, in a temporary folder.

Every run calls the API and costs money; the script prints the token usage and an approximate cost at the end. Options: `-- --only chat` or `-- --only ledger`, `-- --case <id>`, and `-- --repeat <n>` (the model's answers vary, so repeat a case before trusting one result). Full transcripts are saved to `backend/eval/results/` (not committed). Two cases are marked "read": the checks cannot tell on their own whether the reply invented an answer, so read those transcripts.

## Before going live

This is a checklist, not a deployment guide; no hosting provider has been chosen yet.

- **Hosting:** the app keeps all records in files under `data/`, so it needs a long-running server with a persistent disk. On a host whose disk is wiped on redeploy or restart, every record and the audit log would be lost.
- **Data residency:** see `docs/data-residency.md` for what is stored where and what is sent to the Claude API. Record the chosen provider and region there.
- **HTTPS and proxies:** serve the site only over HTTPS. Most hosts put a proxy in front of the app; set `TRUST_PROXY` in `.env` to the number of proxy hops (usually `1`) or to the proxy's addresses, as your host documents. Without it, every visitor shares one rate limit, and the session cookie is not marked `Secure` and no `Strict-Transport-Security` header is sent. Do not set it when the app is reached directly, or visitors could fake their IP address.
- **Legal:** `frontend/terms.html`, `frontend/privacy.html`, and the tax disclaimer on each page are placeholders marked "LEGAL REVIEW REQUIRED".
- **AI costs:** set a monthly spending limit on the Anthropic account that owns `ANTHROPIC_API_KEY`.

### Backups and restore

Back up everything in `data/` except `data/sample/`. The server rewrites these files in place, so take the copy while the server is stopped (or no one is using it), for example once a day:

```
cd data && tar czf /path/to/backups/rentledger-$(date +%F).tgz --exclude=sample .
```

Keep backups somewhere other than the server's disk, in the region recorded in `docs/data-residency.md`. Keep them at least as long as the CRA record-keeping rules require; confirm the period on canada.ca.

To restore: stop the server, extract a backup into `data/` (`cd data && tar xzf /path/to/backup.tgz`), and start the server. It checks the rental files at startup and refuses to start if any is invalid.

Restore test, 2026-09-30 (Toronto time): on a local copy with sample data, one staff account, and one rent entry, the files were backed up with the command above, deleted, and restored. Checksums of all 8 files matched, the staff member could sign in, and the ledger and totals were identical. Repeat this test on the real host once it is chosen.

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
5. Create a staff account: `npm run staff:add -- <username> <ADMIN|MANAGER|BOOKKEEPER|ACCOUNTANT>`, then enter a password of at least 12 characters. Sign in at `/login.html` to see the property overview and, for ADMIN and MANAGER, incoming requests. Permissions are defined in `backend/permissions.js` and enforced by the server: every role can view properties; only ADMIN and MANAGER can view and manage maintenance and viewing requests. Accounts are stored with hashed passwords in `data/staff.json` (not committed); sign-in sessions are kept in memory, so staff sign in again after a server restart.
6. Run the tests: `npm test`

## Public chat assistant

The public page has a chat assistant (`POST /api/chat`, prompt in `prompts/tenant-assistant.md`) for tenants and prospective tenants. It can list advertised vacancies, take viewing requests for listed units, and take maintenance requests. It has no access to tenant, lease, or payment records, so it cannot answer questions about a person's own lease or rent; it refers those to the office. Requests are saved to `data/maintenance-requests.json` and `data/viewing-requests.json` (not committed) and written to the audit log. Staff move them forward one step at a time (maintenance: NEW → IN_PROGRESS → COMPLETED; viewings: NEW → SCHEDULED → COMPLETED) or cancel them with a reason; requests are never deleted, and every change is audited. Each visitor (by IP address) can send 20 chat messages a minute and submit 5 requests an hour.

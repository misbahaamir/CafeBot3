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
3. Load the fictional sample data: `npm run seed:sample`. This creates `data/properties.json`, `data/units.json`, `data/tenants.json`, and `data/leases.json` only if they don't already exist. These files hold tenant personal data and are not committed. The server checks them at startup and refuses to start if any is missing, invalid, or inconsistent (for example, two leases overlapping on one unit).
4. Start the server: `npm start` (serves the site and API on the `PORT` from `.env`, default `3000`).
5. Create a staff account: `npm run staff:add -- <username> <ADMIN|MANAGER|BOOKKEEPER|ACCOUNTANT>`, then enter a password of at least 12 characters. Sign in at `/login.html` to see the property overview. Permissions are defined in `backend/permissions.js` and enforced by the server; for now every role can view properties. Accounts are stored with hashed passwords in `data/staff.json` (not committed); sign-in sessions are kept in memory, so staff sign in again after a server restart.
6. Run the tests: `npm test`

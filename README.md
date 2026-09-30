# CafeBot

A café web app.

## Project Structure

- `frontend/` — client-side code (`index.html`, `styles.css`, `app.js`)
- `backend/` — server-side code
- `data/` — data files
- `prompts/` — prompt templates

## Setup

1. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` to a real key.
2. Install backend dependencies: `cd backend && npm install`
3. Start the server: `npm start` (serves the API on the `PORT` from `.env`, default `3000`)
4. Open `frontend/index.html` in a browser, or serve the `frontend/` directory with any static file server.
5. Create a staff account for the staff dashboard: `cd backend && npm run staff:add -- <username> <MANAGER|BARISTA>`, then enter a password of at least 12 characters. Sign in at `/login.html`. Managers can view, advance, and cancel orders; baristas can view and advance them but not cancel. Permissions are defined in `backend/permissions.js` and enforced by the server. Accounts are stored with hashed passwords in `data/staff.json` (not committed); sign-in sessions are kept in memory, so staff sign in again after a server restart.

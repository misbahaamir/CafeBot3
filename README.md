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

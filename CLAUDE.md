# CafeBot

## Purpose

CafeBot is a café web app: a simple ordering/info experience for a café, with a
static frontend and a backend that can serve data and (eventually) power a
chat/ordering assistant.

## Architecture Overview

- `frontend/` — static client: `index.html`, `styles.css`, `app.js`. Talks to
  the backend over HTTP.
- `backend/` — server-side code. Exposes the API the frontend calls.
- `data/` — data files (e.g. menu items, orders) used by the backend.
- `prompts/` — prompt templates used by any LLM-powered features.

## Coding Rules

- Keep changes minimal and scoped to the current task — no speculative
  features, abstractions, or scaffolding for future work.
- Match the style and conventions already present in the file you're editing.
- No dead code, commented-out code, or placeholder functions.
- Add comments only to explain non-obvious *why*, never to restate *what*.

## Money Rules

- Store and compute all amounts as integer cents; never use floating point
  for money.
- Totals, tax, delivery fees, and discounts are computed by deterministic
  backend code, never by the language model.

## Record Rules

- Saved orders are never hard-deleted; they are cancelled with a reason.
- Every order creation, status change, and cancellation writes an entry to
  an append-only audit log.

## Security Rules

- Never commit secrets, API keys, or credentials — use environment variables
  and keep them out of version control.
- Validate and sanitize all input at the backend boundary (never trust the
  frontend).
- Escape/encode any user-generated content rendered in the frontend to avoid
  XSS.
- Use parameterized queries for any database access — never build queries via
  string concatenation.

## Token-Saving Rules

- Read only the files relevant to the current task, not the whole tree.
- Prefer targeted edits over rewriting whole files.
- Avoid restating file contents back in responses; reference file paths and
  line numbers instead.
- Keep explanations concise — favor short, direct answers over long
  summaries.

## Scope Rule

- Only modify the files needed for the current task. Do not touch unrelated
  files, folders, or configuration as a side effect.

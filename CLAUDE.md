# RentLedger

## Purpose

RentLedger is a rental property management web app for a Canadian property
management company. It keeps property, unit, tenant, and lease records, and
will power two chat assistants: a public one for tenants and prospective
tenants, and a signed-in one for staff.

## Architecture Overview

- `frontend/` — static client: the public page (`index.html`), staff sign-in
  (`login.html`), and the staff dashboard (`staff.html`). Talks to the backend
  over HTTP.
- `backend/` — Express server and all business logic. Rental data is read
  through `rentals.js`, which validates it and enforces role permissions.
- `data/` — JSON data files. Rental records and staff accounts are not
  committed; fictional sample data lives in `data/sample/`.
- `prompts/` — prompt templates for the chat assistants (Claude API).

## Coding Rules

- Keep changes minimal and scoped to the current task — no speculative
  features, abstractions, or scaffolding for future work.
- Match the style and conventions already present in the file you're editing.
- No dead code, commented-out code, or placeholder functions.
- Add comments only to explain non-obvious *why*, never to restate *what*.

## Money Rules

- Store and compute all amounts as integer cents in CAD; never use floating
  point for money.
- Totals, balances, and tax figures are computed by deterministic backend
  code, never by the language model.

## Record Rules

- Financial records are never hard-deleted; they are voided with a reason.
  Maintenance and viewing requests are cancelled with a reason, never deleted.
- Every create, update, status change, void, and cancellation writes an entry
  to the append-only audit log.

## Tax Rules

- The app prepares data only and never claims to file with the CRA.
- Any tax rule not confirmed from a canada.ca source must be marked
  `TODO-VERIFY` in a code comment.

## Privacy Rules

- Tenant personal data (names, contact details, lease terms) is never
  committed; only fictional sample data is.
- The public chat assistant must never reveal one tenant's personal data or
  lease terms to anyone who has not been verified as that tenant.

## Security Rules

- Never commit secrets, API keys, or credentials — use environment variables
  and keep them out of version control.
- Validate all input with zod at the backend boundary (never trust the
  frontend or the language model's tool inputs).
- Enforce least-privilege roles on the server, in the data layer, not only in
  the UI.
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

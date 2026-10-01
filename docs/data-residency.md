# Data residency

Status: **no hosting provider or region has been chosen yet.** Fill in the
"Decision" section before going live.

## Where data lives

| Data | Where | Notes |
|---|---|---|
| Properties, units, tenants, leases, office details | `data/*.json` on the server's disk | Tenant names, contact details, and lease terms |
| Maintenance and viewing requests | `data/maintenance-requests.json`, `data/viewing-requests.json` | Name, email, phone, address, and description given by the visitor |
| Rent and expense entries | `data/income.json`, `data/expenses.json` | Payer and vendor names, amounts |
| Staff accounts | `data/staff.json` | Usernames, roles, password hashes |
| Audit log | `data/audit-log.jsonl` | Before/after copies of every change, so it also holds the personal data above |
| Sign-in sessions, rate-limit counters | Server memory only | Rate limits are keyed by visitor IP address; nothing is written to disk |

All of these are in one folder, `data/`, so they are in whatever region the
server and its disk run in.

## Data sent outside the server

Both assistants call Anthropic's Claude API. What is sent:

- **Public chat:** the visitor's messages (which can include their name,
  contact details, and address when they make a request), advertised vacancy
  listings, and `data/office.json`. No tenant or lease records.
- **Rent & expenses assistant:** the staff member's description of the
  transaction, property addresses, unit labels, and the names of current
  tenants (not their contact details).

Where Anthropic processes and stores API requests, and for how long, is not
confirmed here. Check Anthropic's current documentation and terms before going
live. If personal information must stay in Canada, these API calls may need to
change or be turned off.

## Decision

- Hosting provider and region: _not chosen_
- Disk/backup storage provider and region: _not chosen_
- Confirmed Anthropic data handling (with source and date checked): _not done_
- Reviewed by: _not done_

# Module: {name}

**Repo:** {repo} · **Kind:** {frontend|backend} · **Purpose:** one sentence.

## Screens & Routes (frontend) / Endpoints (backend)

Frontend:

| Route | Screen/Page | Guard | Purpose |
|-------|-------------|-------|---------|

Backend:

| Method | Path | Auth | Request | Response | Errors |
|--------|------|------|---------|----------|--------|

## Business Rules

Numbered, testable, with source refs. Capture validations, conditionals, permission checks, status transitions, limits, and defaults.

- **BR-1:** A session cannot be booked when the coach has no connected calendar. (`src/services/x.js:42`)
- **BR-2:** ...

## Data

Frontend: state used (slices/stores), key entities and their shapes as consumed.
Backend: models/schemas with fields, types, constraints, indexes, relations.

## API Calls Consumed (frontend) / Dependencies (backend)

Frontend:

| Method | URL | Trigger (screen/action) | Payload | Response used for |
|--------|-----|-------------------------|---------|-------------------|

Backend: services/DBs/queues this module calls, with purpose.

## Side Effects

Emails, notifications, jobs enqueued, events emitted, external API writes — with trigger condition and source ref.

## Edge Cases & Gotchas

Non-obvious behavior a rebuilder would miss: race handling, retries, timezone logic, legacy quirks, feature flags.

## Files Covered

Every assigned file, one per line. Required — the audit uses this list.

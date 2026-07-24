# SYSTEM — {workspace name}

**Purpose:** one paragraph — what the whole system does for whom.

## Repo Map

| Repo | Kind | Role | Blueprint |
|------|------|------|-----------|

## Cross-Service Flows

Trace the 3-6 core user journeys end to end. For each: numbered steps naming screen → endpoint → service → side effects.

### Flow: {e.g. Coachee books a session}

1. ...

## Contract Table

Every HTTP call consumed vs the endpoint that exposes it.

| Consumer | Method | Path | Exposed by | Status |
|----------|--------|------|------------|--------|
| bonum-webapp | POST | /sessions | services--sessions | OK / MISSING / ORPHAN |

MISSING = consumed but no documented service exposes it. ORPHAN = exposed but no documented consumer (may be an unmapped client).

## Auth Model

Identity provider, token flow, how each service validates, role/permission model.

## Shared Integrations & Infra

External services (calendar, streaming, email...), who uses them, env vars per repo.

## Gaps

Unresolved items from per-repo `_gaps.md` files plus MISSING/ORPHAN contracts, each with a one-line reason.

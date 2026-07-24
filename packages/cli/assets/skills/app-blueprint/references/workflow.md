# app-blueprint workflow

The goal is reconstruction-grade documentation: a competent team with only the blueprint (and no source access) could rebuild the app with the same behavior. Every phase serves that bar.

Workspace root = the parent directory containing the target repos. All output goes to `<workspace-root>/blueprint/`.

## Phase 0 — Inventory (scripts only, zero agent tokens)

Detect the stack from `package.json` deps (or `pyproject.toml`/`requirements.txt`), then run the cookbook below. Write results to `blueprint/<repo>/_inventory.json`. This file is the coverage contract: the audit in Phase 2 checks every item in it.

`_inventory.json` shape:

```json
{
  "repo": "name",
  "stack": ["react", "vite", "redux", "axios"],
  "kind": "frontend | backend | fullstack",
  "files": ["src/..."],
  "routes": [{"path": "/x", "component": "X", "protected": true, "source": "src/App.tsx:120"}],
  "endpoints_exposed": [{"method": "POST", "path": "/sessions", "source": "src/routes/x.js:10"}],
  "http_calls_consumed": [{"method": "GET", "url": "...", "source": "src/services/x.js:5"}],
  "models": [{"name": "User", "source": "src/models/user.js"}],
  "state": [{"slice": "auth", "source": "src/redux/auth.slice.js"}],
  "jobs": [], "events": [], "env_vars": [], "external_integrations": []
}
```

Populate only the arrays that apply to the stack. `files` is always the full source file list.

### Command cookbook

Adapt patterns to the detected stack; these are starting points, not a fixed script. Run several in parallel.

Gotcha: `rg`/`fd` may be shell functions, invisible to subprocesses like python's `/bin/sh`. Run the rg/fd commands in the main Bash shell redirected to temp files, then assemble `_inventory.json` with a script that only parses those files.

- File list: `fd -t f -e ts -e tsx -e js -e jsx -e py . <repo>/src`
- React Router routes: `rg -n '<Route|path=|element=|createBrowserRouter|path:' <router-file>` — JSX routes are often multiline, so `<Route\s` alone misses most of them; capture `path=`/`element=` lines too.
- Express/Nest endpoints: `rg -n '\b(app|router)\.(get|post|put|patch|delete)\(|@(Get|Post|Put|Patch|Delete)\(' <repo>/src`
- HTTP calls consumed: `rg -n 'axios\.(get|post|put|patch|delete)|fetch\(|axios\(' <repo>/src`
- Models: `rg -n 'mongoose\.model|new Schema|prisma\.|sequelize\.define|class .*\(models\.Model\)' <repo>/src`
- Redux/Zustand state: `rg -n 'createSlice|createStore|create\(' <repo>/src/redux <repo>/src/store <repo>/src/stores`
- Jobs/crons: `rg -n 'cron|node-cron|Bull|agenda|setInterval' <repo>/src`
- Events/websockets: `rg -n '\.emit\(|\.on\(|socket|EventEmitter' <repo>/src`
- Env vars: `rg -oN 'process\.env\.[A-Z_]+|import\.meta\.env\.[A-Z_]+' <repo>/src | sort -u`
- External integrations: `rg -n 'firebase|googleapis|stripe|twilio|sendgrid|aws-sdk|@aws' <repo>/src <repo>/package.json`

## Phase 1 — Module fan-out

Partition the inventory into 6-12 modules **by business domain** (auth, scheduling, evaluations, billing...), never by folder — a feature's logic spans pages, components, hooks, and services. Always include cross-cutting modules when present: `api-layer` (services/adapters/interceptors), `state` (stores/slices).

Spawn ALL module agents in one message (Agent tool, `subagent_type: general-purpose`, `model: sonnet`). Prompt template per agent:

```
Document the "<module>" module of <repo> for reconstruction: someone rebuilding
the app from your doc alone must not lose any behavior.

Files assigned (read all of them fully): <file list from inventory>
Inventory slice (routes/endpoints/calls for this module): <slice>

Write the doc to <workspace-root>/blueprint/<repo>/<module>.md following the
template at <skill-dir>/assets/module-template.md (use the frontend or backend
sections per the repo kind: <kind>). Write in English.

Non-negotiable: business rules as numbered testable statements (BR-1, BR-2...)
with file:line refs. Capture validations, conditionals, permission checks,
status transitions, side effects (emails, notifications, jobs), and edge cases.
End the doc with a "Files covered" list of every assigned file you documented.

Your final message must be ONE line: "<module>: N rules, M endpoints/routes, files X/Y".
Do not include doc content in your final message.
```

## Phase 2 — Audit + synthesis

1. Spawn one audit agent (inherit session model). It reads `_inventory.json` and every `Files covered` section plus route/endpoint tables in the module docs, then returns the list of inventory items not mapped anywhere (files, routes, endpoints, models, slices, jobs).
2. If unmapped items remain: spawn gap agents (same template as Phase 1) to extend existing docs or add a `misc.md`. Re-audit once. Anything still unresolved goes to `_gaps.md` with the reason — never silently dropped.
3. Write `blueprint/<repo>/README.md` yourself: purpose, stack, module index, full route table (path, guard, screen, services consumed) or endpoint table, env vars, external integrations.

Report to the user: files written, coverage (mapped/total inventory items), gaps.

## `all` mode

Discover repos in the workspace root (dirs with `package.json`/`pyproject.toml`), confirm the list and exclusions with the user, then run Phases 0-2 per repo sequentially. Suggest `system` mode when done.

## `system` mode

Reads blueprints only — never source code. Requires existing per-repo blueprints.

1. Read every `blueprint/<repo>/README.md` and the api-layer/endpoint tables.
2. Build the contract table: each HTTP call consumed by a frontend must match an endpoint exposed by some service. Mark `OK`, `MISSING` (nothing exposes it), or `ORPHAN` (exposed, never consumed).
3. Write `blueprint/SYSTEM.md` from `assets/system-template.md`: system overview, repo map, cross-service flows (trace the 3-6 core user journeys end to end), contract table, auth model, shared integrations, gaps.

MISSING contracts are findings, not errors — an undocumented consumer may exist (mobile app, excluded repo). List them in SYSTEM.md.

## Model assignment

| Work | Model |
|------|-------|
| Phase 0 scripts | none (Bash) |
| Module + gap agents | `sonnet` |
| Audit, README, SYSTEM.md | inherit session model |

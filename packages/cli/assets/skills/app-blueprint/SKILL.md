---
name: app-blueprint
description: Generate reconstruction-grade docs of an app — business rules, endpoints, routes, screens, contracts. Trigger: app blueprint, appblueprint, reverse-spec, mapear app, map app for reconstruction.
---

## Activation Contract

Activate on `/app-blueprint <target>` or requests to map/document an app well enough to rebuild it without losing logic or features. Targets: `<repo-dir>` (one repo), `all` (every repo in the workspace root minus user exclusions), `system` (cross-repo synthesis from existing blueprints).

## Hard Rules

- Output goes to `<workspace-root>/blueprint/<repo>/`. All docs in English.
- Phase 0 inventory is mandatory and script-only (`rg`/`fd`, zero agent reading). `_inventory.json` is the coverage contract for the whole run.
- Module agents write their doc file directly to disk and return ONE summary line. Never pipe doc content through the orchestrator context.
- Business rules are numbered, testable statements with `file:line` refs. No prose-only rules.
- Partition modules by business domain, never by folder.
- The run is not done until the audit maps every inventory item (route, endpoint, model, page, slice, job) to a doc section, or lists it in `_gaps.md`.

## Decision Gates

| Target | Action |
|--------|--------|
| Single repo | Phases 0-2 on that repo per `references/workflow.md` |
| `all` | Phases 0-2 per repo, one repo at a time |
| `system` | Read existing blueprints only (no source code), cross-check contracts, write `SYSTEM.md` |
| Frontend stack detected | Module docs use frontend sections of the template |
| Backend stack detected | Module docs use backend sections of the template |

## Execution Steps

1. Read `references/workflow.md` in full before acting.
2. Phase 0: detect stack, run the inventory command cookbook, write `_inventory.json`.
3. Phase 1: partition into 6-12 domain modules; spawn all module agents in parallel (Agent tool, single message, `model: sonnet`), each pointed at `assets/module-template.md`.
4. Phase 2: audit coverage against `_inventory.json`; spawn gap agents for unmapped items; write the repo `README.md`.
5. `system` mode: cross-check consumed vs exposed endpoints across blueprints; write `SYSTEM.md`.

## Output Contract

Per repo: `blueprint/<repo>/{README.md, _inventory.json, <module>.md...}` plus `_gaps.md` if items remain unresolved. System mode: `blueprint/SYSTEM.md`. Final report to user: files written, coverage count (mapped/total), gaps.

## References

- `references/workflow.md` — phase details, inventory command cookbook, agent prompt templates, audit rules.
- `assets/module-template.md` — module doc template (frontend/backend sections).
- `assets/system-template.md` — SYSTEM.md skeleton with contract table.

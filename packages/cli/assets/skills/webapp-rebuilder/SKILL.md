---
name: webapp-rebuilder
description: Trigger: rebuild web app, reconstruir app, rebuild from blueprint, redesign rebuild, webapp rebuilder. Phased web app reconstruction from an app-blueprint: preserve every business rule, redesign UX/UI.
---

# Webapp Rebuilder

## Activation Contract

Activate when the user wants to rebuild an existing web app from its app-blueprint docs (`blueprint/<repo>/`), modernizing stack and redesigning UX/UI while preserving behavior. Requires an existing blueprint; if none exists, run app-blueprint first.

## Hard Rules

- The blueprint is the source of truth for BEHAVIOR: business rules (BR-*), API contracts, capabilities. It is NOT a UI spec — redesigning screens, flows, and navigation is encouraged; losing a capability is forbidden.
- Any feature or BR intentionally dropped must be an explicit entry in the charter kill-list, approved by the user. Nothing is dropped silently.
- Maintain `_traceability.md` in the new repo: every BR from the blueprint → status (`implemented@test`, `implemented`, `killed@charter`, `pending`). The rebuild is not done until no `pending` remains.
- Consume backend endpoints exactly as documented in the blueprint's `api-layer.md`. Never invent or "improve" an endpoint contract — the real services are live.
- Each BR becomes a test before or with its implementation (BRs are already written as testable statements).
- Orchestrate, never implement inline: delegate each phase to sub-agents per `~/.claude/skills/app-builder/references/orchestration.md`. Complete phases in order; a phase starts only after the previous gate passes.
- For ANY UI work, load skills via the ui-skills CLI first (`npx ui-skills start`). UI primitives from shadcn/ui copied into `components/ui/*`, owned and editable. Phase 4 builds structural character in grayscale; color arrives in Phase 5.
- All artifacts in English. Conventional commits, no AI attribution.

## Decision Gates

| Situation | Action |
|-----------|--------|
| No blueprint for the target app | Stop; run app-blueprint first |
| Blueprint has `_gaps.md` entries touching a phase | Surface them in that phase's charter section; user decides |
| BR contradicts observed service behavior during Phase 2 | Trust the live service, note the correction back into the blueprint |
| Scope creep mid-phase | Log as post-MVP in the charter, finish the current gate |

## Execution Steps

1. Read `references/workflow.md` in full before acting.
2. Phase 0: write the rebuild charter from `assets/charter-template.md`; user approves it explicitly before any code.
3. Phases 1-6 per the workflow phase table (scaffold → typed API layer → domain/BR tests → UX redesign + UI → visual identity → polish), delegating each to sub-agents with its blueprint slice as spec.
4. Phase 7: adversarial traceability audit — every BR accounted for in `_traceability.md`; gaps trigger a fix round.
5. Phase 8: ship docs (README + DEPLOYMENT via ship-docs).

## Output Contract

A working repo for the rebuilt app plus: `docs/rebuild-charter.md`, `_traceability.md` (100% BRs resolved), per-phase Engram/memory records, and ship docs. Final report: capabilities delivered, BRs implemented/killed, redesign decisions taken.

## References

- `references/workflow.md` — phase table with models/skills/gates, blueprint-slice-per-phase mapping, traceability audit rules.
- `assets/charter-template.md` — rebuild charter template (stack, redesign scope, kill-list).
- `~/.claude/skills/app-builder/references/orchestration.md` — delegation protocol (shared with app-builder).

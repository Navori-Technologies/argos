# webapp-rebuilder workflow

Goal: rebuild a web app from its blueprint with a modern stack and redesigned UX, losing zero behavior. The blueprint gives you what app-builder's Phase 0 has to invent — so Phase 0 here is about DECISIONS, not discovery.

Inputs: `blueprint/<repo>/` (README, module docs, api-layer.md, ui-shell.md or route table, state doc, `_inventory.json`). Target: a new repo (or workspace app) chosen in the charter.

## Phase table

Model tiers: cheap for mechanical, top tier only where judgment or taste decides. Load listed skills before starting the phase. `ui:*` skills come from the ui-skills CLI.

| # | Phase | Input from blueprint | Output | Gate | Model | Skills |
|---|-------|----------------------|--------|------|-------|--------|
| 0 | Rebuild charter | README + module index + gotchas/edge-case sections | `docs/rebuild-charter.md` from the template: target stack, backend strategy, UX redesign scope, kill-list, capability map | User approves explicitly | fable | cognitive-doc-design |
| 1 | Scaffold | charter only | Repo scaffolded (default: Vite + React 19 + TS strict + Tailwind 4 + shadcn/ui + TanStack Router/Query, unless charter overrides), CI-ready, boots | App boots, typecheck clean | haiku | ponytail |
| 2 | Typed API layer | `api-layer.md` (every consumed endpoint) + auth/interceptor rules | Typed client: one function per endpoint with zod schemas for payload/response, auth token flow, error mapping | Contract smoke test against real services (or recorded fixtures) passes | sonnet | typescript, zod-4, ponytail |
| 3 | Domain + BR tests | Business Rules sections of every module doc | Pure domain logic; each applicable BR encoded as a unit test (BR id in test name) | All BR tests pass; `_traceability.md` updated | sonnet | typescript, pytest-style discipline via strict TDD |
| 4 | UX redesign + UI | Screens/routes + capabilities per module doc — treat as a CAPABILITY inventory, not a screen spec | New information architecture: regrouped flows, reduced tap-count, modern navigation; core screens with structural character in grayscale; owned `components/ui/*` | User walks all flows; every blueprint capability reachable; screens have grayscale personality | sonnet | ui:impeccable (PRIMARY), ui:bolder, react-19, tailwind-4 |
| 4.5 | UX refinement | usage of Phase 4 build | Density audit, flow chaining, empty states, error copy | User confirms flows FEEL right | sonnet | ui:impeccable, ui:relevant, ponytail |
| 5 | Visual identity | brand inputs from user | Color tokens + real typography pairing + signature element | User confirms distinctive, not generic | fable | frontend-design, ui:typeset, ui:colorize |
| 6 | Polish | — | Micro-interactions, motion, a11y pass | Verified in browser | fable | ui:motion, verify |
| 7 | Traceability audit | full blueprint + `_traceability.md` | Adversarial audit: every BR → implemented@test / implemented / killed@charter. Gaps → fix round → re-audit once; leftovers reported, never dropped | Zero `pending` BRs | inherit session model | — |
| 8 | Ship docs | real repo | README.md + DEPLOYMENT.md | Fresh clone boots from README | sonnet | ship-docs, cognitive-doc-design |

## Phase 0 — charter specifics

Read the blueprint README and module index; do NOT re-read source code of the legacy app. Produce the charter with:

- **Capability map**: one line per module — what the user can DO (derived from routes + BRs), independent of how old screens sliced it. This is the redesign's raw material.
- **Kill-list candidates**: mine the blueprint's gotchas/edge-cases/dead-config sections for legacy quirks, disabled features, and dead flows; propose each as keep/kill with a one-line reason. The user decides every entry.
- **Backend strategy**: default is consuming the existing services per `api-layer.md` unchanged. Migrating a service is out of scope unless the user asks.
- **Redesign scope**: which flows get rethought (with the pain point motivating it) vs rebuilt as-is.

One batched question round with the user, then the document. Target ≤2 iterations.

## Traceability rules

- `_traceability.md` lives at the new repo root: a table per module — BR id, one-line rule, status, evidence (test file or charter kill-list ref).
- Seed it in Phase 0 with every BR at `pending` (script the extraction: `rg '\*\*BR-\d+' blueprint/<repo>/*.md`).
- Phases 3 and 4 update statuses as they land; Phase 7 verifies claims adversarially (spot-check: open the cited test, run it).
- A BR that applies only to killed features gets `killed@charter` with the kill-list entry as evidence.
- UI-behavior BRs (guards, visibility rules, redirects) count as implemented only with a route/component test or an explicit Phase 7 manual verification note.

## Redesign guardrails

- Redesign changes HOW a capability is reached, never WHETHER it exists.
- When collapsing N legacy screens into one flow, list the absorbed routes in the module's traceability section so the audit can match them.
- Blueprint side effects (emails, notifications, socket events) triggered by user actions must survive the redesign — the trigger may move, the effect may not.

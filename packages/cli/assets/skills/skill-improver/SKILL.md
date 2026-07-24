---
name: skill-improver
description: Audit and upgrade existing LLM-first skills. Trigger: improve skills, audit skills, refactor skills, skill quality.
---

## Activation Contract

Use this skill when asked to audit, refactor, normalize, or improve existing `SKILL.md` files. Use `skill-creator` instead when creating a brand-new skill from a reusable pattern.

## Hard Rules

- Treat `docs/skill-style-guide.md` as the normative style contract when it exists.
- Use `references/skill-style-guide.md` as the bundled local copy when `docs/skill-style-guide.md` is unavailable.
- Treat `SKILL.md` as the source of truth; preserve author intent, critical rules, activation semantics, and output requirements.
- Default to audit-only. Modify files only when the user explicitly asks to apply improvements.
- Never delete meaningful content silently; move long explanation, examples, templates, or schemas into local `references/` or `assets/`.
- Do not invent triggers, policies, or domain rules. Mark ambiguous cases for human review.

## Decision Gates

| Situation | Action |
| --- | --- |
| Missing or invalid frontmatter | Fix `name` and quoted one-line `description` — the only two allowed fields |
| Skill reads like tutorial docs | Convert to runtime instructions and move background to `references/` |
| Body exceeds budget | Preserve rules, move examples/background to supporting files |
| Branching logic hidden in prose | Convert to a compact decision table |
| Rules conflict or intent is unclear | Report the issue; do not rewrite that rule automatically |

## Execution Steps

1. Read `docs/skill-style-guide.md`; if unavailable, read `references/skill-style-guide.md`; if neither exists, enforce the core LLM-first structure: frontmatter, Activation Contract, Hard Rules, Decision Gates, Execution Steps, Output Contract, References.
2. Scan the skill directories under `assets/skills/` for `*/SKILL.md` to select skills to audit.
3. For each selected skill, audit frontmatter, trigger clarity, section order, body budget, actionability, decision gates, output contract, and local references.
4. Return an audit report grouped by skill with severity and exact proposed changes.
5. In apply mode, edit only safe issues, preserve content, and create supporting files when needed. There is no per-repo registration or refresh step to run afterward: skills live once in the global motor and Argos detects them dynamically.

## Output Contract

Return:
- Skills audited and paths used.
- Issues found, grouped by severity.
- Files changed, if apply mode was requested.
- Ambiguities that need human review.

## References

- `docs/skill-style-guide.md` — normative LLM-first skill style guide for this repo.
- `references/skill-style-guide.md` — bundled local copy for the global skill when the repo doc is unavailable.

_Adapted from a skill originally authored by gentleman-programming._

---
name: skill-creator
description: Create LLM-first skills with valid frontmatter. Trigger: new skills, agent instructions, documenting AI usage patterns.
---

## Activation Contract

Create a skill when:
- A pattern is used repeatedly and AI needs guidance
- Project-specific conventions differ from generic best practices
- Complex workflows need step-by-step instructions
- Decision trees help AI choose the right approach

Do not create a skill when the pattern is trivial, one-off, or better served by normal documentation.

## Hard Rules

- When working in this repo, first follow `docs/skill-style-guide.md` as the normative source before creating or updating skills.
- Use `references/skill-style-guide.md` as the bundled local copy of that guide when `docs/skill-style-guide.md` is unavailable.
- If neither guide is available, use the compact inline rules below.
- A skill is a runtime instruction contract for an LLM, not human documentation.
- Do not add a `Keywords` section; preserve essential trigger words in `description`.
- References must point to local files.
- Keep the skill body concise: target 180–450 tokens, recommended max 700, hard max 1000.

## Decision Gates

| Need | Action |
|------|--------|
| Code templates, schemas, fixtures, generated examples | Put them in `assets/` |
| Conceptual detail, edge cases, existing docs | Put local links in `references/` |
| Long explanation in `SKILL.md` | Move it to a supporting file |
| Multiple meaningful paths | Add a compact decision table |

## Execution Steps

1. Check whether `docs/skill-style-guide.md` exists; if it does, apply it before the bundled local copy or inline fallback rules.
2. If the repo guide is unavailable, read `references/skill-style-guide.md` and apply it before the inline fallback rules.
3. Confirm the skill does not already exist and the pattern is reusable.
4. Create or update `assets/skills/{skill-name}/SKILL.md` using this required structure:

```
assets/skills/{skill-name}/
├── SKILL.md              # Required - main skill file
├── assets/               # Optional - templates, schemas, examples
│   ├── template.py
│   └── schema.json
└── references/           # Optional - links to local docs
    └── docs.md           # Points to docs/developer-guide/*.mdx
```
5. Use this frontmatter shape:

```markdown
---
name: {skill-name}
description: "Trigger: {essential trigger words users or agents will say}. {What this skill does}."
---
```
6. Write sections in this order: Activation Contract, Hard Rules, Decision Gates, Execution Steps, Output Contract, References.
7. There is no per-repo registration step: skills live once in the global motor (`packages/cli/assets/skills/`) and Argos detects them dynamically. Do not add a registration entry in any repo's `AGENTS.md`.

## Inline Fallback Rules

- `description` MUST be one physical line, quoted, YAML-safe, and include essential trigger words first.
- `description` SHOULD be <=160 chars and MUST be <=250 chars.
- Frontmatter MUST include exactly `name` and `description` — no other fields.
- Use imperative instructions, not tutorials or background prose.
- Put supporting material in `assets/` or `references/`, not the main skill body.

Good:

```yaml
description: "Trigger: Jira task, ticket, issue, task creation. Create Jira tasks in the team format."
```

Bad:

```yaml
description: >
  Create Jira tasks in the team format.
  Trigger: Jira task, ticket, issue, or task creation.
Keywords: jira, task
```

## Output Contract

Return:
- Files created or modified.
- Whether the repo style guide or inline fallback rules were used.
- Any supporting files added under `assets/` or `references/`.

## References

- `docs/skill-style-guide.md` — normative LLM-first skill style guide for this repo.
- `references/skill-style-guide.md` — bundled local copy for the global skill when the repo doc is unavailable.

_Adapted from a skill originally authored by gentleman-programming._

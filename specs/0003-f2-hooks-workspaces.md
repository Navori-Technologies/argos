# Spec 0003 — F2: hooks globales y workspaces

Estado: draft
Fecha: 2026-07-24

## Alcance

Fase 2 del spec 0001: (a) hooks user-level parametrizados por la config del
repo, (b) registro de workspaces con match rules e integración en `adopt`,
(c) flota de agentes OpenClaw desde el registro.

## Hooks globales parametrizados

Los hooks viven UNA vez en `~/.claude` y leen los datos del repo en runtime —
el repo no lleva hooks propios.

- Scripts: `~/.claude/hooks/argos-guard-destructive.sh` y
  `~/.claude/hooks/argos-quality-gate.sh`, instalados por `argos init` con
  ownership por prefijo de nombre `argos-` + primera línea
  `# argos:file v="<version>"` (estilo shell del marker de archivo).
- `argos-guard-destructive.sh` (PreToolUse, matcher Bash): bloquea patrones
  destructivos (force-push a rama base, `rm -rf` fuera de scratch,
  `--no-verify`), adaptado del guard probado en navori-harness.
- `argos-quality-gate.sh` (PreToolUse, matcher Bash sobre `git commit`):
  localiza `argos.config.json` subiendo desde el cwd; si existe y
  `qualityGate.fast` no es el placeholder, lo ejecuta y bloquea el commit si
  falla. Sin config → no-op silencioso (el aterrizaje ya avisa).
- `settings.json` de `~/.claude`: `argos init` hace **merge quirúrgico** — solo
  agrega/actualiza las entradas de hooks cuyos comandos apuntan a scripts
  `argos-*`; todo lo demás del settings del usuario queda byte-intacto. Nunca
  se eliminan entradas ajenas; re-init es idempotente.
- `doctor`: reporta hooks faltantes, desactualizados (versión del marker) o
  entradas de settings huérfanas (script borrado).

## Workspaces con match rules

Registro machine-local en `~/.argos/workspaces.json`:

```json
{
  "bonum":    { "match": { "remotes": ["github.com-bonum"], "paths": [] },
               "repos": [{ "name": "...", "path": "/abs/path" }] },
  "personal": { "match": { "remotes": ["github.com-personal"], "paths": [] },
               "repos": [] }
}
```

- Cadena de resolución al vincular: **nombre explícito** >
  **`workspace` en argos.config.json** > **match rules** (remote primero,
  path como fallback) > error pidiendo nombre. Match ambiguo (2+ workspaces)
  → error listando candidatos; nunca se adivina entre identidades.
- `argos workspace link [nombre]`: registra el repo actual (crea el workspace
  si no existe). Al crear por primera vez con match único, ofrece guardar el
  remote del repo como match rule (el registro se auto-enseña).
- `argos workspace show [nombre]`: estado de todos los repos registrados.
- `argos adopt`: tras escribir la config, resuelve la cadena y auto-vincula;
  si no resuelve, lo reporta como paso pendiente (no bloquea el adopt).
- Paths se normalizan (absolutos, symlinks resueltos); entradas con path
  inexistente se reportan en `show`/`doctor`, no se borran solas.

## Flota OpenClaw

`argos workspace agents <nombre> [--apply] [--prefix <p>]` — un agente OpenClaw
por repo registrado, portando el diseño probado en navori-harness:

- Preview por default (imprime los comandos, no ejecuta nada).
- `--apply`: exige el binario `openclaw` en PATH (error claro si falta);
  `openclaw agents add <nombre> --workspace <path> --non-interactive` por
  repo vía spawn con argv (sin shell), timeout de 120s, ETIMEDOUT clasificado.
- Clasificación de resultado: created / exists (patrón anclado a contexto de
  agente/nombre, nunca un "duplicate" suelto) / error (stderr recortado).
  Fallas por repo no abortan el loop; el resumen y exit code reportan el
  parcial honesto.

## Doctor (F2)

Se agregan: hooks (presencia, versión, huérfanos), workspace (repo adoptado
pero sin vincular → sugerencia, path del registro inexistente), y los checks
F1 sin cambios.

## Fuera de alcance (F3+)

`argos export`, pin por repo, pipeline de ticket, migración asistida.

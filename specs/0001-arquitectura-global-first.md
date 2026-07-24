# Spec 0001 — Arquitectura global-first

Estado: draft
Fecha: 2026-07-24

## Contexto

navori-global-harness es una versión propia del harness, divergente del diseño
original (navori-harness, derivado del harness de Ulises). El original optimiza
para equipos, multi-engine (Claude Code, Cursor, Copilot, AGENTS.md) y
distribución del harness vía archivos commiteados en cada repo. Ese diseño paga
costos que este proyecto no necesita:

- Dos capas de contenido (global `~/.claude` + render por repo) que exigen un
  sistema de scopes, gestión de colisiones entre capas y detección de drift.
- Los mismos assets (agentes, skills, bloques) renderizados N veces: una por
  repo, con placeholders resueltos en render-time. Actualizar el harness exige
  re-renderizar la flota completa (`workspace render --apply`).
- Duplicación de agentes: los 12 agentes de rol existen en `~/.claude/agents` y
  en cada `.claude/agents` de cada repo, distinguidos solo por shadowing de cwd.
- Ceremonia entre instalar y trabajar: `global init` + por repo `init` +
  `render` + `workspace link` + sync continuo.

Caso de uso real de este harness: un solo operador, Claude Code como único
engine, sesiones locales y chat-first en VPS (OpenClaw, un agente por repo),
repos propios y de Bonum separados por identidad git.

## Principio

**El harness global es el motor; el repo son datos.**

Todo el contenido ejecutable/instruccional vive UNA vez, a nivel usuario
(`~/.claude`): persona, bloques de CLAUDE.md, skills, agentes, hooks,
orquestación. Cada repo aporta exclusivamente configuración declarativa
(`navori.config.json`). Los skills, agentes y hooks resuelven esa config en
**runtime** (leen el archivo del repo donde trabajan), no en render-time.

Consecuencias directas:

- No hay render de contenido por repo → no hay scopes, ni colisiones entre
  capas, ni drift, ni sweeps de sincronización de contenido.
- Actualizar el harness = actualizar el paquete + `navori render` una vez por
  máquina. Los 18 repos no se tocan.
- Un agente/skill se define una vez y trabaja en cualquier repo.

## Capas

| Capa | Contenido | Se actualiza |
|---|---|---|
| Motor (`~/.claude`) | CLAUDE.md global, output-style, skills, agents, hooks, settings | con el paquete, 1 vez por máquina |
| Datos (repo) | `navori.config.json` (+ CLAUDE.md delgado opcional con hechos del repo) | casi nunca; a mano o con `navori adopt` |
| Registro (`~/.navori`) | workspaces (bonum / personal), selección global, backups | por comandos |

## Componentes del motor

1. **CLAUDE.md global (managed)**: identidad/idioma, formato de respuesta,
   aterrizaje en repos (detección de config, sugerir `adopt`, aviso de sesión
   no anclada), orquestación (tabla de escalado, paralelismo, lentes 4R,
   presupuesto de delegación, tier por costo-beneficio-velocidad), operaciones
   seguras, protocolo engram, ponytail.
2. **Agentes** (`~/.claude/agents/`): el roster de roles (explorer, researcher,
   implementer, reviewer, lentes 4R, ticket-audit, commit-pr-pilot, auditor).
   Sus instrucciones referencian "el quality gate del repo (navori.config.json)"
   — nunca un comando hardcodeado.
3. **Skills** (`~/.claude/skills/`): pipeline de ticket (ticket-intake con fase
   de aterrizaje, review-diff, verify-before-done, pr-create, loop-back-debug,
   spec-bootstrap) + skills de oficio (judgment-day, chained-pr, branch-pr,
   etc.). Todo skill que necesite datos del repo los lee de la config en
   runtime.
4. **Hooks globales parametrizados**: hooks user-level (settings.json global)
   cuyo script localiza el `navori.config.json` del repo del cwd y ejecuta SU
   quality gate / guardas. El repo no lleva hooks propios.
5. **Workspaces + flota OpenClaw**: registro machine-local con match rules por
   remote/path; `navori workspace agents <ws>` genera un agente OpenClaw por
   repo registrado.

## navori.config.json (datos del repo)

Esquema mínimo: `name`, `language`, `workspace`, `branchBase`, `prTarget`,
`qualityGate { fast, full }`, `project { criticalAreas, legacyPaths }`,
`identity` (alias git esperado — verifica la regla Bonum/personal). Sin
presets, sin engines, sin selección de skills: eso es del motor.

## Flujo objetivo

```
npm i -g navori-global          # una vez por máquina
navori init                     # motor completo a ~/.claude (interactivo 1 vez)
# ... por repo:
git clone <repo> && cd <repo>
navori adopt                    # detecta stack + quality gate + identidad por
                                # remote → escribe navori.config.json, linkea
                                # workspace (match rules), sugiere agente OpenClaw
# a trabajar — no hay paso 3
```

`adopt` es idempotente y el único comando per-repo. En VPS, el aterrizaje del
CLAUDE.md global instruye al agente a correrlo cuando falta la config.

## Qué se hereda de navori-harness (probado hoy)

- Resolución genérica de placeholders a punteros de config (mecanismo
  GLOBAL_SKILL_TEMPLATE_DEFAULTS) — acá se vuelve el default único.
- Guard de archivos ajenos en `~/.claude` (skipped-foreign) y backups.
- `workspace agents` (timeout, clasificación de duplicados, preview-first).
- Markers managed para todo lo que el motor escribe en `~/.claude`.
- Reglas de orquestación (incluida "agiliza con subagentes por default").

## Non-goals (v1)

- Multi-engine (Cursor/Copilot/AGENTS.md): Claude Code only.
- Distribución del harness vía archivos commiteados al repo del equipo.
- Presets por stack y lib-skills auto-detectadas (el motor es genérico; los
  hechos del stack caben en la config del repo).
- i18n de assets (español neutro único).

## Tradeoffs aceptados

- Resolución runtime: el modelo lee la config del repo en vez de recibir el
  comando inline (costo en tokens y un salto de indirección por sesión).
- Un teammate sin navori instalado no recibe nada del harness clonando el repo.
- Hooks globales corren en todo repo con config; sin config, no hay gate
  automático (el aterrizaje lo advierte).

## Fases

1. **F1 — Motor mínimo**: `navori init` (CLAUDE.md global + persona + agentes +
   skills core), `navori adopt`, `doctor`.
2. **F2 — Hooks globales parametrizados** + workspaces con match rules +
   `workspace agents`.
3. **F3 — Pipeline de ticket completo** (ticket-intake con aterrizaje integrado)
   + migración desde navori-harness (script que lee configs existentes).

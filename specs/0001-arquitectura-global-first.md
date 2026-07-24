# Spec 0001 — Argos: arquitectura global-first

Estado: draft
Fecha: 2026-07-24

## Identidad

- Nombre: **argos** (Argos Panoptes — el guardián de cien ojos: un motor
  global, todos los repos a la vista).
- Binario CLI: `argos`. Config por repo: `argos.config.json`. Estado de
  máquina: `~/.argos/`. Markers managed: `<!-- argos:managed ... -->`.
- Todo el namespace es propio: Argos coexiste en la misma máquina y los mismos
  repos con el harness original (navori/Ulises) sin pisarse — cada herramienta
  reclama solo sus bloques y su config.

## Contexto

Argos es una versión propia del harness, divergente del original de Ulises
(navori-harness). El original optimiza para equipos y multi-engine mediante
render de contenido por repo; ese diseño paga costos estructurales:

- Dos capas de contenido (global `~/.claude` + render por repo) → sistema de
  scopes, colisiones entre capas, detección de drift.
- Los mismos assets renderizados N veces (una por repo); actualizar exige
  re-renderizar la flota completa.
- Duplicación de agentes (globales + por repo, distinguidos por shadowing).
- Ceremonia entre instalar y trabajar: init global + init/render/link por repo
  + sync continuo.

Caso de uso primario: un operador, Claude Code como engine de trabajo,
sesiones locales y chat-first en VPS (OpenClaw, un agente por repo), repos
personales y de Bonum separados por identidad git.

## Principio

**El motor es global; el repo son datos; el equipo recibe un compilado.**

Todo el contenido ejecutable/instruccional vive UNA vez a nivel usuario
(`~/.claude`): persona, bloques de CLAUDE.md, skills, agentes, hooks,
orquestación. Cada repo aporta exclusivamente configuración declarativa
(`argos.config.json`). Los skills, agentes y hooks resuelven esa config en
**runtime** (leen el archivo del repo donde trabajan), no en render-time.

Consecuencias:

- No hay render de contenido por repo para operar → no hay scopes, ni
  colisiones entre capas, ni sweeps de sincronización de contenido.
- Actualizar = actualizar el paquete + `argos render` una vez por máquina.
- Un agente/skill se define una vez y trabaja en cualquier repo.

## Dos modos, un motor

### Modo operador (default, global-first)

El de arriba. Tus sesiones (locales o VPS) usan el motor de `~/.claude` +
la config del repo. Nada del harness vive versionado en el repo salvo
`argos.config.json`.

### Modo equipo (`argos export`)

Para repos donde un equipo sin Argos instalado necesita el harness, o donde se
usan otros engines: `argos export` **compila** el motor + la config del repo en
artefactos versionables — CLAUDE.md con gates resueltos, `.claude/` mínimo,
`.cursor/rules/`, `.github/copilot-instructions.md`. Propiedades:

- Es un build para terceros: las sesiones del operador NUNCA dependen del
  export; siguen usando el motor global.
- Los engines (Cursor/Copilot/AGENTS.md) dejan de ser arquitectura de primera
  clase: son formatos de salida del export.
- `argos doctor` compara versión del motor vs export commiteado y reporta
  drift; `argos export --apply` regenera. Solo los repos que exportan entran a
  ese sweep (opt-in explícito en la config).
- El export lleva markers `argos:managed` con versión, igual que todo lo que
  Argos escribe.

El export es además el **mecanismo de pin por repo**: exportar congela el
estado compilado del harness en ese repo (versionado en su git, revisable por
PR, con rollback). La ficha declara el pin y las reglas del export mandan en
ese repo (patrón de deferencia del motor). Un repo pinneado re-crea la doble
capa a propósito y `doctor` lo reporta con versiones (motor vs export). En
repos no exportados el control de versión del motor es por máquina — no
existe rollout gradual por repo, por definición de fuente única.

## Capas

| Capa | Contenido | Se actualiza |
|---|---|---|
| Motor (`~/.claude`) | CLAUDE.md global, output-style, skills, agents, hooks, settings | con el paquete, 1 vez por máquina |
| Datos (repo) | `argos.config.json` + ficha (CLAUDE.md delgado) | `argos adopt [--refresh]` cuando cambian los hechos del repo |
| Export (repo, opt-in) | CLAUDE.md/.claude/.cursor/copilot compilados | `argos export --apply` cuando cambia el motor |
| Registro (`~/.argos`) | workspaces (bonum / personal), selección, backups | por comandos |

## Componentes del motor

1. **CLAUDE.md global (managed)**: identidad/idioma, formato de respuesta,
   aterrizaje en repos (detección de config, sugerir `adopt`, aviso de sesión
   no anclada), orquestación (tabla de escalado, paralelismo, lentes 4R,
   presupuesto de delegación, tier por costo-beneficio-velocidad, agilizar con
   subagentes por default), operaciones seguras, protocolo engram, ponytail.
2. **Agentes** (`~/.claude/agents/`): roster de roles (explorer, researcher,
   implementer, reviewer, lentes 4R, ticket-audit, commit-pr-pilot, auditor).
   Referencian "el quality gate del repo (argos.config.json)" — nunca un
   comando hardcodeado.
3. **Skills** (`~/.claude/skills/`): pipeline de ticket (ticket-intake con
   fase de aterrizaje, review-diff, verify-before-done, pr-create,
   loop-back-debug, spec-bootstrap) + skills de oficio (judgment-day,
   chained-pr, branch-pr, etc.). Datos del repo → de la config, en runtime.
4. **Hooks globales parametrizados**: hooks user-level cuyo script localiza el
   `argos.config.json` del repo del cwd y ejecuta SU quality gate / guardas.
   El repo no lleva hooks propios (salvo vía export para el equipo).
5. **Workspaces + flota OpenClaw**: registro machine-local con match rules por
   remote/path; `argos workspace agents <ws>` genera un agente OpenClaw por
   repo registrado.

## argos.config.json (datos del repo)

Esquema mínimo: `name`, `language`, `workspace`, `branchBase`, `prTarget`,
`qualityGate { fast, full }`, `project { criticalAreas, legacyPaths }`,
`identity` (alias git esperado — verifica la regla Bonum/personal),
`stack` (hechos detectados: framework, package manager, libs relevantes),
`skills` (qué skills del motor aplican a este repo — detectados en adopt),
`export { engines: [...] }` (opt-in del modo equipo).

Los skills viven una sola vez en el motor; el repo declara CUÁLES le aplican.
La detección ocurre en `adopt` (una vez), no en runtime: cero tokens de
detección por sesión, y la selección queda explícita y auditable.

## Ficha del repo (CLAUDE.md delgado)

`adopt` escribe además una ficha: un CLAUDE.md de ~10 líneas (`argos:managed`)
con los hechos resueltos en texto literal — quality gate, rama base, áreas
críticas, workspace, skills aplicables. Claude Code la auto-carga al trabajar
en el repo, así el modelo no gasta ni un Read para conocer el repo.

Distinción crítica con el render del harness original: la ficha es
**presentación de datos del repo**, no contenido del harness. Se regenera con
`adopt --refresh` cuando cambian los hechos del repo (nueva lib, otro gate) —
**nunca por actualizar el motor**. El drift entre capas no puede existir
porque las capas no comparten contenido. `doctor` compara ficha/config contra
`package.json` y sugiere re-adopt cuando quedaron viejas.

## Coexistencia y migración desde navori-harness

- Namespaces disjuntos (binario, config, markers, `~/.argos`): un repo puede
  tener ambos harnesses sin conflicto; `argos doctor` reporta la convivencia.
- `argos adopt` detecta un `navori.config.json` existente e **importa** sus
  datos (name, quality gate, áreas críticas, workspace) — migración gratis.

## Flujo objetivo

```
npm i -g argos-harness          # una vez por máquina
argos init                      # motor completo a ~/.claude (interactivo 1 vez)
# ... por repo:
git clone <repo> && cd <repo>
argos adopt                     # detecta stack + quality gate + identidad por
                                # remote → escribe argos.config.json, linkea
                                # workspace (match rules), sugiere agente OpenClaw
# a trabajar — no hay paso 3. Equipo/multi-engine: argos export (opt-in).
```

## Qué se hereda de navori-harness (probado)

- Resolución genérica de placeholders a punteros de config — acá es el default
  único del motor; el export usa la resolución concreta (render-time) del
  mismo mecanismo.
- Guard de archivos ajenos en `~/.claude` (skipped-foreign) y backups.
- `workspace agents` (timeout, clasificación de duplicados, preview-first).
- Markers managed con versión para todo lo que Argos escribe.

## Non-goals (v1)

- Presets por stack y lib-skills auto-detectadas (los hechos del stack caben
  en la config del repo).
- i18n de assets (español neutro único).
- Export a engines adicionales más allá de Cursor/Copilot/AGENTS.md.

## Tradeoffs aceptados

- La ficha del repo elimina la indirección para los hechos frecuentes (gate,
  rama, skills); la indirección runtime queda solo para datos raros que la
  ficha no lleva. El costo residual es mantener la ficha fresca (`doctor`
  vigila config/ficha vs package.json).
- Modo equipo requiere el paso de export y su disciplina de regeneración
  (acotada a repos opt-in, con doctor vigilando drift).
- Hooks globales corren en todo repo con config; sin config no hay gate
  automático (el aterrizaje lo advierte).

## Fases

1. **F1 — Motor mínimo**: `argos init` (CLAUDE.md global + persona + agentes +
   skills core), `argos adopt` (con import de navori.config.json), `doctor`.
2. **F2 — Hooks globales parametrizados** + workspaces con match rules +
   `workspace agents`.
3. **F3 — `argos export`** (modo equipo: CLAUDE.md/.claude/cursor/copilot) +
   doctor de drift motor↔export.
4. **F4 — Pipeline de ticket completo** (ticket-intake con aterrizaje
   integrado) + migración asistida desde navori-harness.

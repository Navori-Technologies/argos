---
name: ticket-intake
description: Aterrizaje en el repo + pipeline canónico de 8 fases para procesar un ticket (ID, URL o texto pegado) con gates objetivos, en cualquier repo con argos.config.json. Trigger: llega un ticket o una tarea no trivial y hay que auditar, implementar, revisar y abrir el PR.
---

# ticket-intake — aterrizaje + pipeline de 8 fases

## Cuándo usar este skill

Cuando llega un ticket (ID, URL o texto pegado) y la tarea no es trivial. Orquesta el ciclo encadenando agentes y skills del motor global de Argos con gates objetivos: el contexto que pagas con tokens en una fase queda escrito para la siguiente, sin depender de la memoria del modelo. Los agentes de rol (`ticket-audit`, `explorer`, `implementer`, `reviewer`, las lentes 4R, `commit-pr-pilot`) viven una sola vez en `~/.claude/agents/` y están disponibles en cualquier sesión — pero los hooks globales parametrizados y sus gates automáticos solo disparan dentro de una sesión anclada en la raíz del repo (ver Fase 0).

## Fase 0 — Aterrizaje + Triage

Antes de tocar el ticket, verifica el contexto del repo. No asumas nada de sesiones anteriores.

1. **Sesión anclada**: si el cwd de la sesión está por debajo de la raíz real del repo, Claude Code descubre agentes/skills/hooks solo desde el cwd hacia arriba, nunca hacia abajo — la config que vive en la raíz puede no cargar. Recomienda anclar la sesión en la raíz del repo antes de encarar trabajo no trivial.
2. **`argos.config.json` presente**: si falta, sugiere correr `argos adopt`. Nunca lo corras unilateralmente — propónlo y espera confirmación explícita del usuario.
3. **Ficha fresca**: si la ficha del repo (el CLAUDE.md delgado) se ve desactualizada, o el stack/las dependencias del repo divergieron de lo que declara (nueva librería, otro quality gate, otro framework), sugiere `argos adopt --refresh`.
4. **Repo no clonado**: si el ticket referencia un repo que todavía no existe en esta máquina, primero clónalo respetando las reglas de identidad — el remote debe usar el alias SSH que matchea el workspace correcto (`bonum` / `personal`, según las match rules por remote/path registradas en `~/.argos/workspaces.json`) — y recién ahí corre `argos adopt`.
5. **Triage propiamente dicho**: `mem_search`, `cat progress/current.md`, `git status`/`git log`. Trivial (≤1 archivo, ≤5 líneas, sin lógica) → salta directo a Fase 5. Si `current.md` no está en `idle` con OTRO ticket, pregunta antes de seguir; nunca dos tickets en paralelo sobre el mismo `current.md`.

**Gate de Fase 0**: no entres al pipeline (Fase 1 en adelante) hasta que 1-3 queden resueltos, o el usuario haya confirmado explícitamente seguir sin ellos a sabiendas de que algún gate automático puede no disparar.

## Pipeline (fases 1–8)

Cada fase escribe en `.claude/progress/` — ruta relativa a la raíz de ESTE repo, nunca al motor global; crea el directorio si no existe. El gate de cada fase es bloqueante.

| Fase | Quién la cubre | Artefacto / Gate |
|---|---|---|
| 1 · Context (opc.) | tú: CLI del tracker (`acli` / `jira` / `gh issue view`) | Si solo hay texto pegado, salta a 2 con él. |
| 2 · AUDIT | agente `ticket-audit` | `audit_<ID>.md`: root cause/approach, archivos, alternativas, preguntas, tasks. **Gate: el usuario lo aprueba.** |
| 3 · EXPLORE (opc.) | 2-3 agentes `explorer` en un solo mensaje (paralelo real, ver orquestación) | Un `explore_<dim>.md` por dimensión (handler, schema, side-effects, caller, memoria). **Gate: validas que el approach del audit sigue vivo.** |
| 4 · DESIGN (opc.) | agente `implementer` | Solo si hay patrón o librería nueva: presenta 2-3 approaches con tradeoffs y espera OK explícito. Si no aplica, salta a 5. |
| 5 · IMPLEMENT | UN agente `implementer` | Lee la ficha del repo (CLAUDE.md delgado) → `audit_<ID>.md` → `explore_*.md` → skill aplicable. Produce `impl_<feature>.md`. **Gate: el quality gate fast del repo — resuelto en runtime desde `qualityGate.fast` en `argos.config.json` o la ficha, nunca un comando asumido — verde en este turno.** |
| 6 · VERIFY | skill `verify-before-done` (la corre el `implementer`) | `impl_<feature>.md` con "Verify ejecutado en este turno" en exit 0 + smoke del endpoint. Sin evidencia fresca → vuelve a 5. |
| 7 · REVIEW | agente `reviewer` + skill `review-diff` (+ lentes 4R en paralelo si el diff es de riesgo — ver tabla de perfil en el bloque de orquestación) | `review_<feature>.md`. Two-stage; Stage 1 falla → `CHANGES_REQUESTED`, vuelve a 5 con un `implementer` FRESCO (agente nuevo, no el mismo con el transcript viejo). `APPROVED` → sigue. **Cap: 2 ciclos `CHANGES_REQUESTED` sobre el mismo ticket → escala al usuario en vez de reintentar en loop.** |
| 8 · PR + CLOSE | agente `commit-pr-pilot` (aplica skill `pr-create`) | Pre-flight del pilot: working tree limpio, no estás en la rama base ni en la `prTarget` del repo (resueltas del `argos.config.json`/ficha), quality gate verde, `gh auth status` ok. PR creado y URL al usuario; luego `mem_save`, entrada en `history.md`, `current.md` a `idle` y `mem_session_summary`. |

## Reglas duras

- **La Fase 2 no se salta en tarea no-trivial** "porque ya entendiste el ticket". El audit es para el `implementer` (y para ti en 3 días); delégalo a `ticket-audit`.
- **El `implementer` arranca leyendo `audit_<ID>.md`** o pierdes contexto ya pagado con tokens.
- **El `reviewer` no aprueba sin Stage 1;** la aprobación NO depende del `implementer`.
- **No hay PR sin `APPROVED`** ni dos tickets en paralelo sobre el mismo `current.md`.
- **Trivial** = ≤1 archivo, ≤5 líneas, sin lógica.
- **Sin `argos.config.json` ni ficha**, no asumas un quality gate ni una `prTarget` fija — léelos del repo (o de `package.json`/scripts si ninguno existe) antes de declarar un gate verde, y sugiere `argos adopt` (Fase 0) antes de avanzar.

## Antes de declarar listo

- La Fase 0 corrió: sesión anclada (o advertida), `argos.config.json`/ficha resueltos o el usuario confirmó seguir sin ellos.
- El ciclo cerró con un PR vía `commit-pr-pilot` (skill `pr-create`) y su URL al usuario; `current.md` en `idle`.
- Hubo `mem_save` de toda decisión no obvia y `mem_session_summary`.
- Si fue no-trivial: existen `audit_<ID>.md` aprobado, `impl_<feature>.md` con verify en exit 0 y `review_<feature>.md` en `APPROVED`.

Este skill vive una sola vez en el motor global (`~/.claude/skills/`) y aplica a cualquier repo con `argos.config.json`. Ningún comando de quality gate, rama base/destino o alias de identidad vive hardcodeado aquí: todo se resuelve en runtime leyendo la config o la ficha del repo donde se está trabajando.

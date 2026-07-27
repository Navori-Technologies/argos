# Spec 0005 — Engram como parte del motor + auto mode por defecto

Estado: implemented
Fecha: 2026-07-27

## Contexto

El motor instala agentes, skills, hooks y voz, pero la memoria persistente
(Engram) y el permission mode quedan como pasos manuales del operador. Este
spec integra ambos a `argos init`: el plugin `engram@engram` (marketplace
GitHub `Gentleman-Programming/engram`) se instala como parte del motor, y
`permissions.defaultMode` queda en `"auto"` cuando el operador no tiene uno
configurado.

Hechos verificados (2026-07-27):

- Claude Code registra plugins en `settings.json` (`enabledPlugins`,
  `extraKnownMarketplaces`) y su estado en `~/.claude/plugins/`
  (`installed_plugins.json`, `known_marketplaces.json`, `cache/`). La única
  vía scriptable documentada para instalar es el CLI: `claude plugin
  marketplace add <owner/repo>` + `claude plugin install <plugin>@<mkt>`
  (scope `user` por defecto). Escribir solo las claves de settings NO está
  documentado como instalación válida — no lo hacemos.
- `permissions.defaultMode` acepta `default | acceptEdits | plan | auto |
  dontAsk | bypassPermissions`; `"auto"` existe literal (docs
  permission-modes).

## Requisitos (EARS)

- **R1** — CUANDO `argos init` corre con la opción `installEngram` activa y
  el plugin `engram@engram` NO figura habilitado en
  `settings.json.enabledPlugins`, el sistema DEBE registrar el marketplace
  `Gentleman-Programming/engram` e instalar el plugin ejecutando el CLI
  `claude` (`plugin marketplace add` + `plugin install`, scope user), y
  reportar la fila `plugins#engram` con status `created`.
- **R2** — SI `settings.json.enabledPlugins["engram@engram"]` ya es `true`
  ENTONCES el sistema DEBE reportar `plugins#engram` como `unchanged` sin
  ejecutar ningún proceso externo.
- **R3** — SI el binario `claude` no está en PATH, o cualquiera de los dos
  comandos termina con exit code ≠ 0 (excepto "marketplace ya registrado",
  que se tolera y continúa) ENTONCES el sistema DEBE reportar
  `plugins#engram` con status `error` y un `detail` que incluya los dos
  comandos manuales, sin escribir claves de plugins en `settings.json` y sin
  abortar el resto del init.
- **R4** — CUANDO el wizard interactivo corre (TTY, sin `--yes`), el sistema
  DEBE preguntar si instalar Engram (default sí); al declinar, el paso se
  omite por completo (sin fila, sin proceso externo).
- **R5** — CUANDO `argos init` corre con la opción `setAutoMode` activa y
  `settings.json` NO define `permissions.defaultMode`, el sistema DEBE
  setearlo a `"auto"` con el mismo contrato quirúrgico del merge existente
  (solo esa clave, mtime guard, escritura atómica) y reportar la fila
  `settings.json#defaultMode` (`created` si `permissions` no existía,
  `updated` si existía sin `defaultMode`).
- **R6** — SI `permissions.defaultMode` ya existe ENTONCES el sistema NO
  DEBE modificarlo: valor `"auto"` se reporta `unchanged`; cualquier otro
  valor se reporta `skipped-foreign` con el valor actual en `detail`.
- **R7** — CUANDO el wizard interactivo corre, el sistema DEBE preguntar si
  activar auto mode (default sí); al declinar, la clave no se toca y no se
  emite fila.
- **R8** — CUANDO `argos doctor` corre con el motor instalado, el sistema
  DEBE emitir warning si `engram@engram` no está habilitado en
  `settings.json` y warning si `permissions.defaultMode` está ausente, cada
  uno con su comando/acción sugerida.
- **R9** — SI no hay TTY o se pasa `--yes` ENTONCES `installEngram` y
  `setAutoMode` DEBEN comportarse con default `true` (paridad con
  `installAgents`/`installHooks`, spec 0004) sin ningún prompt.
- **R10** — CUANDO `argos remove --apply` corre, el sistema DEBE eliminar
  `permissions.defaultMode` SOLO si su valor es exactamente `"auto"`
  (simetría con la política de `outputStyle`), y NO DEBE desinstalar ni
  deshabilitar el plugin Engram (la memoria acumulada es del operador).

## Design

### Enfoque

Dos pasos nuevos dentro de `runInit`, misma filosofía que los existentes:
core puro y testeable, wizard como capa aditiva (spec 0004), merge
quirúrgico de settings (spec 0003/0004). La instalación de Engram delega en
el CLI `claude` en vez de reimplementar el gestor de plugins: es la única
superficie documentada y mantiene `~/.claude/plugins/*` fuera de nuestro
ownership. No hay flags CLI nuevas: `installEngram`/`setAutoMode` son
opciones de `InitOptions` + preguntas del wizard, igual que
`installAgents`/`installHooks`.

### Componentes

- `packages/cli/src/lib/engram-plugin.ts` (nuevo) — peek read-only de
  `enabledPlugins` + orquestación de los dos comandos `claude` vía un runner
  inyectable (`spawnSync` por defecto, mismo patrón inyectable del prompter
  y de openclaw-agents); timeouts 60s (marketplace add) y 120s (install) —
  cubre R1, R2, R3.
- `packages/cli/src/lib/settings-merge.ts` — nueva
  `applyDefaultModePolicy(settingsPath)`: gemela de
  `applyOutputStylePolicy`, mismo mtime guard + `writeFileAtomic`; nunca
  toca otra clave — cubre R5, R6.
- `packages/cli/src/commands/init.ts` — paso 2e (engram, tras el bloque de
  hooks) y 2f (defaultMode, junto a outputStyle); `InitOptions.installEngram`
  y `InitOptions.setAutoMode` (default `true`); dos confirms nuevos en
  `runInitInteractive` + líneas en el resumen — cubre R1, R4, R5, R7, R9.
- `packages/cli/src/commands/doctor.ts` — dos checks read-only nuevos —
  cubre R8.
- `packages/cli/src/commands/remove.ts` — limpieza condicional de
  `permissions.defaultMode === "auto"`; Engram explícitamente fuera — cubre
  R10.

### Decisiones

- Instalar vía CLI `claude`, no escribiendo `enabledPlugins` a mano: el
  efecto de settings-solo-escritura (sin cache en `~/.claude/plugins/`) no
  está documentado; un install a medias es peor que un error accionable.
- `claude` ausente ⇒ fila `error` (exit code 1 del init): `argos` existe
  para operar Claude Code; una máquina sin `claude` es un estado que el
  operador debe ver, con los comandos manuales en el detail.
- `"auto"` fijo, no configurable: es el pedido; un operador con otro modo ya
  seteado nunca es tocado (R6), así que no hace falta knob.
- `argos remove` no toca Engram: desinstalar el plugin borraría acceso a la
  memoria persistente del operador — efecto destructivo fuera del contrato
  de "remover el motor".

## No-goals

- Escribir `enabledPlugins`/`extraKnownMarketplaces` directamente en
  `settings.json` como fallback.
- Desinstalar/deshabilitar Engram desde `argos remove`.
- Flags CLI nuevas para estos toggles (paridad wizard-only con spec 0004).
- Configurar el MCP de Engram o su protocolo en CLAUDE.md (el plugin trae lo
  suyo).

## Tasks

- [x] **T1** (R5, R6) — `applyDefaultModePolicy` en `settings-merge.ts` ·
  test: `src/lib/settings-merge.test.ts`::casos ausente→created, permissions
  sin defaultMode→updated, valor ajeno→untouched, "auto"→unchanged, JSON
  corrupto→error sin escritura, mtime guard `// Covers: R5, R6`
- [x] **T2** (R1, R2, R3) — `lib/engram-plugin.ts` con runner inyectable ·
  test: `src/lib/engram-plugin.test.ts`::ya habilitado→unchanged sin spawn,
  instalación feliz→created con ambos comandos en orden, claude ausente→
  error con comandos en detail, install falla→error, marketplace duplicado
  tolerado `// Covers: R1, R2, R3`
- [x] **T3** (R1, R4, R5, R7, R9) — integración en `runInit` +
  `runInitInteractive` (pasos 2e/2f, opciones, confirms, resumen) · test:
  `src/commands/init.test.ts`::rows nuevas con defaults, declinar engram/auto
  en wizard omite paso, `--yes`/no-TTY sin prompts con defaults true
  `// Covers: R1, R4, R5, R7, R9`
- [x] **T4** (R8) — checks de doctor · test:
  `src/commands/doctor.test.ts`::warning engram ausente, warning defaultMode
  ausente, silencio cuando ambos presentes `// Covers: R8`
- [x] **T5** (R10) — limpieza en `remove.ts` · test:
  `src/commands/remove.test.ts`::elimina defaultMode solo si "auto", valor
  ajeno intacto, enabledPlugins intacto `// Covers: R10`

## Criterios de aceptación

- Suite existente pasa sin cambios (`pnpm nx run-many -t build test`).
- Todo R<n> cubierto por ≥1 task y ≥1 test con su `// Covers:`.
- `--yes`/no-TTY: cero prompts nuevos; solo aparecen las filas nuevas.

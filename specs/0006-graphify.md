# Spec 0006 — Graphify como parte del motor

Estado: implemented (Judgment Day design 2 rondas; apply cerrado con verificación objetiva del orquestador tras stalls de infraestructura en el re-juicio — hallazgo único de ronda 1 resuelto y verificado por grep + gate)
Fecha: 2026-07-31

## Contexto

Graphify (repo `Graphify-Labs/graphify`, paquete PyPI `graphifyy`) convierte
un codebase en un knowledge graph consultable: parsing AST local vía
tree-sitter, skill `/graphify` para Claude Code, hook `PreToolUse` que empuja
a consultar el grafo en vez de grep, y git hook `post-commit` de rebuild.
Este spec lo integra al motor en dos superficies: `argos init` instala y
registra la parte user-scope (binario + skill global), y `argos adopt`
instala la parte project-scope (hook PreToolUse + registro en el repo
adoptado). Precedente de patrón: spec 0005 (Engram).

Hechos verificados contra el repo real (2026-07-31, rama default `v8`,
consistente con PyPI 0.9.31 — `main` está desactualizada; toda lectura
futura del repo debe fijar `?ref=v8` o el tag de release):

- Instalación del binario: `uv tool install graphifyy` o
  `pipx install graphifyy`. Requiere Python 3.10+.
- `graphify install` (sin flags) es user-scope: copia `SKILL.md` a
  `~/.claude/skills/graphify/SKILL.md` (respeta `$CLAUDE_CONFIG_DIR`) y
  agrega un bloque `## graphify` a `~/.claude/CLAUDE.md` con dedupe propio
  por substring. NO instala el hook PreToolUse.
- `graphify install --project` es project-scope: escribe `hooks.PreToolUse`
  en `<repo>/.claude/settings.json` y un bloque marcado `## graphify` en el
  `CLAUDE.md` del repo. Idempotente por sus propios marcadores.
- `graphify hook install` instala un git hook `post-commit` en el repo
  (respeta `core.hooksPath`) que rebuildea el grafo AST-only (sin LLM).
- `graphify install` no documenta contrato de exit codes; la única
  clasificación confiable es ENOENT/timeout del spawn + stdout/stderr crudo.
  Por eso todo `created` user-scope exige smoke test (`graphify --version`).
- Corriendo como skill dentro de Claude Code usa el modelo de la sesión; no
  requiere API key propia en `init`.

Decisiones de alcance del operador (2026-07-31): wizard de `init` con
default sí (paridad Engram); `init` intenta instalar el binario cuando falta
y `uv`/`pipx` existen; smoke test post-instalación; la pieza project-scope
vive en `adopt` (se descartó un comando dedicado `argos graphify`); el build
inicial del grafo NO corre en `adopt` (lo generan el post-commit hook y el
primer uso del skill).

## Requisitos (EARS)

Superficie user-scope (`argos init`):

- **R1** — CUANDO `argos init` corre con la opción `installGraphify` activa,
  el binario `graphify` NO está en PATH y `uv` (o en su defecto `pipx`) SÍ
  está, el sistema DEBE instalar el binario ejecutando `uv tool install
  graphifyy` (o `pipx install graphifyy` cuando solo hay `pipx`) antes de
  continuar con el registro del skill.
- **R1b** — SI el comando de instalación de R1 termina exitoso (exit 0)
  pero el binario `graphify` sigue sin resolverse en PATH del proceso
  ENTONCES el sistema DEBE reportar `tooling#graphify` con status `error` y
  un `detail` que aclare que el binario SÍ quedó instalado y que falta
  actualizar el PATH de la shell (`uv tool update-shell` o reabrir la
  shell), sin reintentar la instalación, sin ejecutar `graphify install` y
  sin sugerir re-correr el comando de instalación.
- **R2** — CUANDO el binario `graphify` está en PATH (previo, o recién
  instalado por R1 sin caer en la rama de error de R1b) y el skill NO está
  registrado
  (`<claudeDir>/skills/graphify/SKILL.md` ausente), el sistema DEBE ejecutar
  `graphify install` y después el smoke test `graphify --version`; solo con
  ambos exitosos DEBE reportar la fila `tooling#graphify` con status
  `created`.
- **R3** — SI el binario `graphify` está en PATH y
  `<claudeDir>/skills/graphify/SKILL.md` ya existe ENTONCES el sistema DEBE
  reportar `tooling#graphify` como `unchanged` sin ejecutar ningún proceso
  externo. Esta condición se evalúa después de un eventual R1 en el mismo
  run: si R1 acaba de instalar el binario y el skill ya estaba registrado,
  la fila DEBE reportar `updated` con detail "binario instalado; skill ya
  registrado", sin ejecutar `graphify install` ni el smoke test.
- **R4** — SI ni `graphify`, ni `uv`, ni `pipx` están en PATH ENTONCES el
  sistema DEBE reportar `tooling#graphify` con status `error` y un `detail`
  que incluya los comandos manuales (`uv tool install graphifyy` o
  `pipx install graphifyy`, y `graphify install`), sin abortar el resto del
  init.
- **R5** — SI cualquiera de los comandos de R1/R2 termina con error de spawn
  (ENOENT, timeout) o exit code ≠ 0, o el smoke test falla ENTONCES el
  sistema DEBE reportar `tooling#graphify` con status `error` y un `detail`
  con la causa (stderr/stdout crudo o código de error) más los comandos
  manuales, sin reportar `created`.
- **R6** — CUANDO el wizard interactivo de `init` corre (TTY, sin `--yes`),
  el sistema DEBE preguntar si instalar Graphify (default sí); al declinar,
  el paso se omite por completo (sin fila, sin proceso externo).
- **R7** — SI no hay TTY o se pasa `--yes` ENTONCES `installGraphify` DEBE
  comportarse con default `true` sin ningún prompt (paridad R9 del spec
  0005).

Doctor:

- **R8** — CUANDO `argos doctor` corre, el sistema DEBE emitir warning si el
  binario `graphify` no está en PATH y warning si
  `<claudeDir>/skills/graphify/SKILL.md` no existe, cada uno con su
  comando/acción sugerida; ambos checks son read-only y nunca lanzan.

Superficie project-scope (`argos adopt`):

- **R9** — CUANDO `argos adopt` (o `--refresh`) corre con la opción
  `installGraphify` activa, el binario `graphify` está en PATH y el hook
  PreToolUse de graphify NO figura en `<cwd>/.claude/settings.json`, el
  sistema DEBE ejecutar `graphify install --project` y luego
  `graphify hook install` en el cwd, re-verificar vía el peek
  `hasGraphifyProjectHook(cwd)` que el hook quedó efectivamente escrito, y
  solo con esa re-verificación positiva reportar la fila `graphify` con
  source `detected` (simetría con el smoke test user-scope de R2: sin
  contrato de exit codes, un éxito sin verificación es un estado a medias).
- **R10** — SI el hook PreToolUse de graphify ya figura en
  `<cwd>/.claude/settings.json` ENTONCES el sistema DEBE reportar la fila
  `graphify` con source `detected` y valor "ya instalado", sin ejecutar
  ningún proceso externo. Esta condición tiene PRECEDENCIA sobre R11: se
  evalúa antes que la detección de binario (un hook ya commiteado en el
  repo cuenta como instalado aunque la máquina no tenga `graphify` en
  PATH).
- **R11** — SI el binario `graphify` NO está en PATH ENTONCES `adopt` DEBE
  reportar la fila `graphify` con source `warning` y los comandos manuales,
  SIN marcar exit code 1 (a diferencia de `init`: el trabajo core de adopt
  — config + ficha — no depende de graphify).
- **R12** — SI cualquiera de los dos comandos de R9 falla (spawn o exit ≠
  0), o la re-verificación post-install de R9 no encuentra el hook en
  `<cwd>/.claude/settings.json` ENTONCES el sistema DEBE reportar la fila
  `graphify` con source `error` y la causa + comandos manuales en `value`,
  marcando exit code 1 del adopt.
- **R13** — CUANDO el wizard interactivo de `adopt` corre, el sistema DEBE
  preguntar si instalar el hook de Graphify en el repo (default sí); al
  declinar, el paso se omite por completo. Sin TTY o con `--yes`, default
  `true` sin prompt.

Remove:

- **R14** — CUANDO `argos remove --apply` corre, el sistema NO DEBE tocar
  nada de graphify: ni el binario, ni `skills/graphify/`, ni el bloque
  `## graphify` de ningún CLAUDE.md, ni hooks de repos (simetría con la
  política de Engram, R10 del spec 0005: lo acumulado es del operador).

## Design

### Enfoque

Misma filosofía del spec 0005: core puro y testeable, wizard como capa
aditiva, delegación total en el instalador ajeno (`graphify install` es
quien escribe `~/.claude/CLAUDE.md`, `.claude/settings.json` del repo y sus
skills — Argos nunca replica esas escrituras ni las hace por su cuenta). La
diferencia con Engram: no hay fuente de verdad JSON documentada para "¿está
instalado?", así que la detección es `hasBinary` + existencia de
`SKILL.md` (user) / peek del hook en settings del repo (project), y todo
`created` user-scope se confirma con smoke test porque `graphify install`
no tiene contrato de exit codes.

### Componentes

- `packages/cli/src/lib/graphify-plugin.ts` (nuevo) — gemelo de
  `engram-plugin.ts`: tipos `GraphifyCliResult`/`GraphifyRunner`
  (inyectables, default `spawnSync`). A diferencia del runner de Engram
  (un solo binario), la firma es
  `(binary: "uv" | "pipx" | "graphify", args: string[], timeoutMs: number,
  cwd?: string) => GraphifyCliResult` — un único runner para los tres
  binarios de la cascada; `cwd` solo lo pasa el project-scope (los tests
  usan directorios temporales, nunca `process.cwd()` implícito).
  `manualGraphifyCommands()`,
  `isGraphifySkillRegistered(claudeDir)` (existencia de
  `skills/graphify/SKILL.md`), `hasGraphifyProjectHook(cwd)` (peek read-only
  de `hooks.PreToolUse` en `<cwd>/.claude/settings.json`, nunca lanza,
  ausente/corrupto ⇒ `false`), `installGraphifyUserScope(claudeDir, opts)`
  (cascada R1→R1b→R2 con detección vía `hasBinary` inyectable para tests,
  re-ejecutada tras un install exitoso del binario) y
  `installGraphifyProjectScope(cwd, opts)` (R9/R10/R12, con re-peek
  post-install). Timeouts: 300s para `uv tool install`/`pipx install`
  (resuelve deps Python), 60s para `graphify install`,
  `graphify install --project` y `graphify hook install`, 30s para
  `graphify --version` — cubre R1–R5, R9, R10, R12.
- `packages/cli/src/lib/which.ts` — `hasBinary` se consume tal cual para
  `graphify`/`uv`/`pipx`; no se modifica.
- `packages/cli/src/commands/init.ts` — paso 2g (tras 2f auto mode):
  `InitOptions.installGraphify` (default `true`) +
  `InitOptions.graphifyRunner` inyectable; confirm nuevo en
  `runInitInteractive` (tras el de auto mode, mismo shape que el de Engram
  en `init.ts:566-574`) + línea en el resumen — cubre R1–R7.
- `packages/cli/src/commands/doctor.ts` — `checkGraphify(findings,
  claudeDir)` gemelo de `checkEngramPlugin` (`doctor.ts:252-259`), reusando
  `hasBinary` e `isGraphifySkillRegistered` para que la definición de
  "instalado" nunca diverja entre `init` y `doctor` — cubre R8.
- `packages/cli/src/commands/adopt.ts` — paso nuevo al final de `runAdopt`
  (tras escribir config + ficha, para no bloquear el trabajo core si
  graphify falla): `AdoptOptions.installGraphify` (default `true`) +
  `AdoptOptions.graphifyRunner`; filas `AdoptRow` con los sources
  existentes (`detected`/`warning`/`error`); confirm nuevo en
  `runAdoptInteractive` — cubre R9–R13.
- `packages/cli/src/commands/remove.ts` — sin código nuevo; el no-goal se
  documenta y se fija con test — cubre R14.

### Decisiones

- Binario ausente y sin `uv`/`pipx` en `init` ⇒ fila `error` (exit 1), no
  `skipped`: el operador eligió paridad con Engram (default sí) a sabiendas;
  el `detail` siempre trae los comandos manuales. En `adopt` el mismo caso
  es `warning` sin exit 1 porque el core de adopt (config/ficha) no depende
  de graphify.
- `uv` antes que `pipx`: es el orden del README de graphify; solo se usa el
  fallback cuando `uv` no existe, nunca ambos.
- Smoke test `graphify --version` tras `graphify install`: sin contrato de
  exit codes documentado, un `created` sin smoke sería un estado a medias
  (hallazgo del audit). El smoke corre solo en el camino de instalación —
  `unchanged` (R3) no spawnea nada, paridad con R2 de Engram. Limitación
  aceptada (Judgment Day ronda 1): un binario presente-pero-roto después de
  un primer run exitoso no se re-detecta ni en `init` (R3) ni en `doctor`
  (R8) — ambos son no-spawn por diseño y el costo de ejecutar el binario en
  cada corrida no paga ese caso raro.
- Tras un R1 exitoso, el fallo de resolución en PATH se reporta como error
  accionable (R1b) en vez de resolver la ruta absoluta del binario vía
  `uv tool dir --bin`/equivalente pipx: cero contratos nuevos con comandos
  no verificados por el audit; el operador lo resuelve en un paso
  (`uv tool update-shell` o shell nueva) y el siguiente `argos init` cae en
  el camino normal R2.
- Limitación aceptada (Judgment Day ronda 2): si `graphify install
  --project` deja el hook PreToolUse escrito pero `graphify hook install`
  falla, los re-runs de `adopt` caen en R10 ("ya instalado") y no
  reintentan el git hook — el remedio es el comando manual que el `detail`
  del error del run fallido ya incluye. Verificar el git hook en disco
  exigiría resolver `core.hooksPath` por repo, superficie que no paga un
  caso de segundo orden ya reportado como `error`/exit 1 en su primer run.
- Default sí en `adopt` es deliberadamente más invasivo que el precedente
  de Engram: instala git hook `post-commit` + `PreToolUse` en cada repo
  adoptado apenas `graphify` esté en PATH. Tradeoff aceptado explícitamente
  por el operador (2026-07-31) — prioriza que todo repo adoptado quede con
  el grafo operativo; el wizard permite declinar repo por repo (R13).
- El bloque `## graphify` que `graphify install` agrega a
  `~/.claude/CLAUDE.md` queda fuera del sistema de marcadores de Argos y se
  acepta como superficie de una herramienta externa (mismo espíritu que
  `~/.claude/plugins/*` de Engram): ni `init` lo gestiona, ni `remove` lo
  limpia, ni `doctor` lo reporta como drift.
- El build inicial del grafo no corre en `adopt`: en repos grandes puede
  tardar y el post-commit hook + el primer uso del skill lo generan solos.
- `installGraphify` como opción de `InitOptions`/`AdoptOptions` + pregunta
  de wizard, sin flags CLI nuevas (paridad wizard-only del spec 0005).

## No-goals

- Ejecutar el build inicial del grafo (`graphify <path>`) desde `init` o
  `adopt`.
- Gestionar Python, `uv` o `pipx` (instalarlos, actualizarlos) más allá de
  invocar `uv tool install graphifyy`/`pipx install graphifyy`.
- Escribir o limpiar por cuenta de Argos el bloque `## graphify` de ningún
  CLAUDE.md, el skill `skills/graphify/`, o `hooks.PreToolUse` — esas
  escrituras son siempre del propio `graphify install`.
- Desinstalar graphify desde `argos remove` (R14).
- Comando dedicado `argos graphify` (descartado: `adopt`/`adopt --refresh`
  cubren el caso por-repo).
- Configurar el modo MCP de graphify o API keys de backends LLM.

## Tasks

- [x] **T1** (R1, R1b, R2, R3, R4, R5) — `lib/graphify-plugin.ts`:
  user-scope (`installGraphifyUserScope` con cascada uv→pipx, re-detección
  post-install, smoke test, `isGraphifySkillRegistered`, runner y
  `hasBinary` inyectables) · test:
  `src/lib/graphify-plugin.test.ts`::skill ya registrado→unchanged sin
  spawn, binario presente+skill ausente→install+smoke→created, binario
  ausente+uv presente→uv tool install primero, solo pipx→pipx install,
  install del binario exitoso pero PATH sigue sin resolver→error con detail
  de PATH sin reintento ni graphify install, binario recién instalado por
  R1 con skill ya registrado→updated sin graphify install ni smoke, sin
  binario/uv/pipx→error con comandos manuales, install falla→error, smoke
  falla→error sin created `// Covers: R1, R1b, R2, R3, R4, R5`
- [x] **T2** (R9, R10, R12; mismo archivo que T1 — se implementa en serie
  con T1, un solo implementer) — `lib/graphify-plugin.ts`: project-scope
  (`hasGraphifyProjectHook`, `installGraphifyProjectScope` con
  `install --project` + `hook install` + re-peek post-install) · test:
  `src/lib/graphify-plugin.test.ts`::hook ya en settings del repo→sin
  spawn, camino feliz con re-peek positivo→ambos comandos en orden,
  comandos exitosos pero re-peek no encuentra el hook→error, settings
  corrupto→se trata como ausente, falla de cualquiera→error con causa
  `// Covers: R9, R10, R12`
- [x] **T3** (R1, R5, R6, R7) — integración en `runInit` (paso 2g, opción
  `installGraphify`, `graphifyRunner`) + `runInitInteractive` (confirm +
  resumen) · test: `src/commands/init.test.ts`::fila `tooling#graphify` con
  defaults, declinar en wizard omite paso, `--yes`/no-TTY sin prompt con
  default true, error de graphify no aborta el resto `// Covers: R1, R5,
  R6, R7`
- [x] **T4** (R9, R10, R11, R12, R13) — integración en `runAdopt` (paso
  final, opción `installGraphify`, `graphifyRunner`) +
  `runAdoptInteractive` (confirm) · test:
  `src/commands/adopt.test.ts`::fila `graphify` en camino feliz, hook ya
  presente→fila `detected` con valor "ya instalado" sin spawn y con
  precedencia sobre binario ausente, binario ausente→warning sin exit 1,
  comando falla→error con exit 1, declinar en wizard omite paso, `--yes`
  default true `// Covers: R9, R10, R11, R12, R13`
- [x] **T5** (R8) — `checkGraphify` en `doctor.ts` · test:
  `src/commands/doctor.test.ts`::warning binario ausente, warning skill
  ausente, silencio con ambos presentes `// Covers: R8`
- [x] **T6** (R14) — test de no-goal en `remove.test.ts`::`remove --apply`
  deja intactos `skills/graphify/` y un bloque `## graphify` en CLAUDE.md
  `// Covers: R14`

## Criterios de aceptación

- Suite existente pasa sin cambios (`pnpm nx run-many -t build test`).
- Todo R<n> cubierto por ≥1 task y ≥1 test con su `// Covers:`.
- Ningún test spawnea binarios reales (`graphify`/`uv`/`pipx`): runner y
  detección de PATH siempre inyectados.
- `--yes`/no-TTY: cero prompts nuevos; solo aparecen las filas nuevas.

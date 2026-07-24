# Spec 0004 — F5: CLI interactivo

Estado: draft
Fecha: 2026-07-24

## Principio

La interactividad es una capa sobre los cores existentes (`runInit`,
`runAdopt`, `runRemove`, `runWorkspace*`), nunca un reemplazo. Regla dura:

- **Con TTY** (operador humano en terminal): prompts de @clack/prompts.
- **Sin TTY, o con `--yes`**: comportamiento actual sin cambios — defaults +
  flags. Esto es obligatorio porque los agentes (OpenClaw, sesiones de Claude
  Code) ejecutan `argos` de forma no interactiva; un prompt bloqueante en ese
  contexto cuelga al agente. `--yes` fuerza el modo no interactivo incluso
  con TTY.

## Superficies

### `argos init`
Wizard: (1) idioma (es/en, default es); (2) toggles — agentes sí/no, hooks
sí/no (default sí ambos; skills siempre se instalan: cargan on-demand y
recortarlos rompe el arsenal); (3) resumen de lo que se va a escribir
(conteos + destino + nota de backup) con confirmación final. Cancelar = no
tocar nada.

### `argos adopt`
Los valores detectados/importados se presentan editables antes de escribir:
nombre, quality gate (fast/full), rama base, workspace resuelto (con la
cadena que lo resolvió visible), identidad. Enter = aceptar lo detectado.
Workspace ambiguo → select de candidatos en vez de error (solo con TTY; sin
TTY se mantiene el error actual). Confirmación final muestra config + ficha.

### `argos remove`
Con TTY, `--apply` pide confirmación explícita escribiendo el nombre del
directorio destino (patrón "escribe ~/.claude para confirmar"); `--purge`
pide una segunda confirmación aparte mencionando los backups. `--yes` salta
ambas (comportamiento actual).

### `argos workspace link`
Ambigüedad de match rules → select interactivo de candidatos. Colisión de
nombre (WorkspaceNameCollisionError) → prompt mostrando ambos paths con
opciones sobrescribir/cancelar (equivalente interactivo de `--force`).

### `argos doctor`
Sin prompts (read-only siempre), pero con TTY los findings warning/error
cierran con sugerencias de comando accionables ya presentes — sin cambios.
Check nuevo: output-style del motor instalado pero `settings.json.outputStyle`
apunta a otra voz → warning "la voz de Argos está instalada pero no activa".

## Activación de la voz (fix del hueco detectado en el VPS)

`argos init` gestiona `settings.json.outputStyle` con esta política:

- Clave ausente → la setea a `"Argos"`.
- Clave apuntando a la voz del harness predecesor (`navori`) → takeover con
  aviso: en modo interactivo pregunta; con `--yes`/sin TTY la reemplaza y lo
  reporta como fila `updated` con detalle explícito.
- Clave apuntando a cualquier otra voz del usuario → NO se toca; se reporta
  como info y `doctor` lo recuerda (warning de voz no activa).

Misma mecánica quirúrgica del merge de hooks: ninguna otra clave se altera.
`argos remove` restaura: si `outputStyle` quedó en `"Argos"`, la elimina (o
restaura el valor previo si el backup lo conserva — mínimo: eliminarla).

## No-goals

- Ningún prompt nuevo en paths sin TTY.
- No prompts en `workspace agents --apply` más allá de lo existente (es la
  superficie que corre por cron/flotas).
- No modo "wizard completo" que encadene init+adopt — cada comando mantiene
  su alcance.

## Criterios de aceptación

- Toda suite existente pasa sin cambios (los cores no cambian de contrato).
- Tests nuevos: TTY simulado (inyección del prompter, no TTY real) para cada
  superficie; `--yes` y sin-TTY byte-idénticos al comportamiento previo.
- El prompter es inyectable (mismo patrón que el runner de openclaw-agents)
  para que los tests no dependan de @clack internals.

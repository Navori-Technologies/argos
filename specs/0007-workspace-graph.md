# Spec 0007 — `argos workspace graph` y regeneración automática tras `adopt`

Estado: implemented
Fecha: 2026-08-03

## Contexto

El harness ya tenía un pipeline externo probado, vivo en
`~/.claude/scripts/` (fuera del producto), para construir el grafo
cross-repo de un workspace: (1) `graphify update <repo>` por repo, (2)
`graphify merge-graphs <graphs...> --out <out>/merged-graph.json`, y (3) un
bridge de contratos (`graphify-bridge.py`, stdlib-only) que inyecta edges
`http_call`/`shared_constant` entre repos y escribe un reporte de llamadas
sin matchear. Este spec lo empaqueta como comando nativo del CLI
(`argos workspace graph [name]`) y lo integra al final de un `adopt`
exitoso, para que un workspace multi-repo recién completado quede con su
grafo operativo sin un paso manual adicional.

Precedente de patrón: spec 0006 (Graphify como parte del motor) — mismo
idioma de runner inyectable + reports con `exitCode`, sin `process.exit` en
la lib.

## Comportamiento del comando

`argos workspace graph [name] [--out DIR] [--no-update] [--dry-run]`

- **Resolución de la raíz**: con `name` explícito, se busca en
  `~/.argos/workspaces.json` (mismo registro de `workspace link`); sin
  nombre, se resuelve el workspace del repo en el cwd actual (cadena
  `argos.config.json#workspace` > match rules del registro — misma cadena
  que usa `workspace link`/`adopt`). Una vez resuelto el nombre, la raíz es
  el directorio padre común de los repos registrados en ese workspace (si
  están bajo padres distintos, error accionable — nunca se adivina).
- **Discovery de repos**: cualquier subdirectorio inmediato de la raíz que
  tenga `graphify-out/graph.json` cuenta como repo del workspace — es un
  concepto puramente de filesystem, independiente de qué repos estén
  registrados en `~/.argos/workspaces.json` (mismo criterio que
  `workspace-graph.sh`). Se requieren >=2; con menos, error.
- **Pipeline**: `graphify update <repo>` por cada repo (salvo `--no-update`,
  que reutiliza el `graph.json` existente de cada uno) → `graphify
  merge-graphs <graphs...> --out <outDir>/merged-graph.json` → el script
  bundleado `graphify-bridge.py` (`python3 <asset> --graph <merged> <repos...>
  --report <outDir>/bridge-report.md`).
- **Out dir**: `--out` explícito si se pasa; si no, `<root>/blueprint/workspace-graph`
  cuando ese directorio ya existe, o `<root>/workspace-graph` en caso
  contrario (mismo default que `workspace-graph.sh`).
- **`--dry-run`**: imprime el plan (raíz, repos, out dir, si se correría
  update) y termina sin tocar el filesystem ni spawnear nada.

## Integración con `adopt`

Al final de un `argos adopt` exitoso (después de escribir config + ficha +
el paso de Graphify project-scope), si el repo resolvió/linkeó un workspace
y su raíz tiene >=2 repos con grafo, se dispara una regeneración en
background (`argos workspace graph <name>` como proceso detached, log en
`<root>/.argos/workspace-graph.log`). Debounce de 10 minutos vía un stamp
file en `~/.argos/workspace-graph-stamps/` — adoptar varios repos del mismo
workspace seguidos dispara una sola regeneración. `--no-workspace-graph`
salta el paso entero (sin fila, sin proceso).

## Degradaciones

- `graphify` no está en PATH → error accionable, nada se ejecuta (ni
  siquiera se crea el out dir).
- Un `graphify update` de un repo puntual falla → no aborta el pipeline; ese
  repo se mergea con su `graph.json` existente (mismo `|| echo "(update
  failed, using existing graph)"` de `workspace-graph.sh`).
- `graphify merge-graphs` falla → error, el bridge nunca se intenta.
- `python3` ausente, o el script del bridge falla → el merge ya generado
  queda (`exitCode 0`), el reporte marca `bridgeSkipped` + un warning; el
  bridge es una mejora cross-repo sobre un merge ya válido, no un requisito
  duro para considerar el comando exitoso.

## Edge cases

- Workspace inexistente en el registro → error.
- Workspace sin repos registrados → error.
- Repos del workspace bajo padres distintos → error (pide `--out`/correr
  desde la raíz real en vez de adivinar).
- `adopt` en un repo nuevo, primer miembro de un workspace (todavía <2 repos
  con grafo) → el paso de regeneración no dispara (silencioso, sin fila).
- Adoptar 3 repos del mismo workspace en sucesión rápida → una sola
  regeneración (debounce de 10 min por raíz, vía stamp file).

## Visualización del puente cross-repo

Hoy la visualización del puente cross-repo se armaba a mano a partir de
`merged-graph.json`. El comando la produce de fábrica: al final del pipeline
(después de merge y, si corrió, del bridge), `runWorkspaceGraph` escribe
`<out>/bridge-graph.html` — una visualización **solo del subgrafo puente**
(los nodos que participan en al menos un edge `_origin === "bridge"`, más
esos edges).

- **Habilitado por default**; `--no-viz` lo salta. Nunca se genera en
  `--dry-run`. Es un paso de mejor esfuerzo: si el merged graph no se puede
  leer/parsear o la escritura falla, el comando igual termina en éxito
  (`exitCode 0`) con `bridgeVizWarning` en el reporte — misma tolerancia que
  el paso de bridge (no es un requisito duro).
- **100% autocontenido**: cero dependencias externas (sin CDN, sin vendorizar
  vis.js). Decisión de renderer propio: dado que el subgrafo puente de un
  workspace real es chico (decenas de nodos, no miles) y el requisito es
  "cero dependencias", un canvas 2D con layout determinista alcanza y evita
  el costo de vendorizar/mantener una librería de grafos completa.
  - Layout **sin física**: se computa en TypeScript (`packages/cli/src/lib/bridge-viz.ts`),
    no en el navegador — mismo grafo de entrada siempre produce las mismas
    coordenadas. Nodos agrupados por repo en clusters circulares; los
    clusters se distribuyen en un círculo grande.
  - Color por repo (paleta fija de 14 colores, asignados por orden
    alfabético de repos).
  - Edges: azul sólido `http_call`, ámbar punteado `shared_constant`.
  - Leyenda lateral con color + conteo de nodos por repo y checkbox para
    ocultar/mostrar ese repo.
  - Hover sobre nodo: tooltip (label, repo, source file). Click en nodo:
    panel con sus edges puente (context + destino).
- Merged graph sin edges bridge (0) → el HTML igual se genera, con mensaje
  explícito ("sin contratos cross-repo detectados") en vez de canvas vacío.
- Implementación: `renderBridgeVizHtml(mergedGraph, opts)` en
  `packages/cli/src/lib/bridge-viz.ts` es una función pura que retorna el
  HTML como string — construido desde un template literal TS (no un asset
  aparte), así el typecheck lo cubre sin resolución de paths extra.
  `runWorkspaceGraph` la llama y escribe el archivo. Los datos embebidos se
  escapan con el patrón anti-XSS estándar (`JSON.stringify(...).replace(/</g,
  "\\u003c")`), más un escapado adicional del lado del navegador antes de
  cualquier interpolación en `innerHTML` (defensa en profundidad, ya que las
  labels vienen de código fuente escaneado, no de una fuente confiable).

## Componentes

- `packages/cli/assets/scripts/graphify-bridge.py` — copia literal de
  `~/.claude/scripts/graphify-bridge.py`. Se ejecuta **en el lugar** (`python3
  <ruta del asset>`) — no requiere instalación ni copia a `~/.claude`; el
  paquete `@argos/cli` ya declara `assets/` en `files` de su
  `package.json`, así que el script viaja con el paquete publicado
  igual que `assets/agents`/`assets/skills`.
- `packages/cli/src/lib/workspace-graph.ts` — lógica pura, runner
  inyectable (`WorkspaceGraphRunner`, gemelo de `GraphifyRunner`):
  `resolveWorkspaceRoot`, `discoverGraphRepos`, `runWorkspaceGraph`
  (pipeline), y el trío de debounce
  `shouldTriggerWorkspaceGraph`/`writeWorkspaceGraphStamp`/
  `triggerWorkspaceGraphBackground` para la integración con `adopt`.
- `packages/cli/src/commands/workspace.ts` — subcomando `graph` (citty),
  junto a `link`/`show`/`agents`; flag `--viz`/`--no-viz` (default `true`).
- `packages/cli/src/lib/bridge-viz.ts` — `renderBridgeVizHtml` (visualización
  del puente cross-repo, ver sección arriba) + tipos `MergedGraph`/
  `MergedGraphNode`/`MergedGraphLink`.
- `packages/cli/src/commands/adopt.ts` — paso final adicional en `runAdopt`:
  `AdoptOptions.workspaceGraph` (default `true`) + `workspaceGraphSpawn`/
  `workspaceGraphNow` inyectables para tests; flag `--no-workspace-graph` en
  el comando.

## No-goals

- Portear `graphify-bridge.py` a TypeScript — se empaqueta tal cual (stdlib
  Python, sin dependencias).
- Prompt interactivo en el wizard de `adopt` para este paso (a diferencia de
  Graphify R13) — el paso es de bajo riesgo (background, debounced, log
  propio) y no bloquea nada; solo tiene el flag `--no-workspace-graph`.
- Resolver automáticamente un `--out` cuando los repos de un workspace están
  dispersos bajo padres distintos.

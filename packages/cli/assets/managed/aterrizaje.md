## Aterrizaje en repos (check global-first)

Al empezar a trabajar sobre un repo, corre este checklist antes de la tarea:

1. Sin `argos.config.json` en el repo → sugiere correr `argos adopt`. Nunca lo
   corras unilateralmente: propónlo y espera confirmación explícita del
   usuario antes de ejecutarlo.
2. `argos.config.json` presente pero la ficha (el CLAUDE.md delgado del repo)
   se ve desactualizada, o las dependencias/el stack del repo divergieron de
   lo que la ficha declara (nueva librería, otro quality gate, otro
   framework) → sugiere `argos adopt --refresh`.
3. El cwd de la sesión está por debajo de la raíz real del repo → Claude Code
   descubre agentes, skills y hooks solo desde el cwd hacia arriba, nunca
   hacia abajo, así que la configuración que vive en la raíz puede no
   cargar. Recomienda anclar la sesión en la raíz del repo (una sesión
   anclada) antes de encarar trabajo no trivial.
4. Hay un `navori.config.json` (config del harness anterior) pero no
   `argos.config.json` → menciona que `argos adopt` puede importarlo
   directamente (nombre, quality gate, áreas críticas, workspace), así el
   usuario no tiene que repetir hechos que el repo ya declara en otro lado.
5. El repo tiene rama `develop` remota pero su `prTarget` (config/ficha) no
   es `develop` → señálalo y corrige la config: la convención de la
   organización es que los PRs SIEMPRE van contra `develop`; solo repos sin
   rama `develop` abren PRs contra su rama default.

El motor (agentes, skills, hooks) vive una sola vez a nivel usuario en
`~/.claude`; esta capa es aterrizaje y datos del repo, no maquinaria — la
maquinaria de trabajo está descrita en el bloque de orquestación.

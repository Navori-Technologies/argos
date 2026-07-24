# Fase 6 — Pulido creativo

## Objetivo

Microinteracciones, movimiento y háptica que hacen la app deleitable, sin romper la identidad ya comprometida. Gate humano: verificado en device real.

## Protocolo

1. **Deleite con criterio.** Lo que funciona: scale-on-press (`active:scale-95`), animaciones de entrada escalonadas, un elemento de firma con movimiento, háptica solo en acciones significativas. Decora contenido, nunca affordances críticas.
2. **Nunca gatees una CTA crítica tras una animación `entering` con delay.** En el primer mount tras el splash (fuentes/DB cargando), Reanimated puede congelar entradas con delay en opacity 0: botón invisible, sin error.
3. **Nunca pongas className en un seam `cssInterop(createAnimatedComponent(...))` para UI crítica.** Cuando el interop falla, falla SILENCIOSO en runtime mientras tsc, tests y `expo export` quedan verdes. El press feedback va en un `Pressable` plano o un wrapper interno.
4. **Háptica detrás de un wrapper** `lib/haptics.ts`. Respeta reduce-motion.
5. **Dev build en device físico temprano:** los simuladores esconden háptica, fuentes y performance.

## Skills

- `rn-performance` — performance de animaciones en RN.
- `verify-before-done` — mapea a la verificación en device: no des la fase por hecha sin evidencia real.
- `motion`, `not-boring-mobile` — si alguna de estas skills no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase; Argos no valida automáticamente disponibilidad de skills externas por fase.

## Cómo verificar el gate

- El usuario verifica el movimiento y la háptica en un device real.
- Ninguna CTA crítica queda invisible tras el primer mount.
- reduce-motion honrado.

## Artifacts

- `lib/haptics.ts`, animaciones y microinteracciones.
- Engram: `app/{app}/phase-6`.

## Modelo

`fable`, effort medio: el gusto guía, pero el scope es acotado.

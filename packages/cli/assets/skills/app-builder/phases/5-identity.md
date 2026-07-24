# Fase 5 — Identidad visual

## Objetivo

Una dirección de color comprometida (valores de tokens) más las dos cosas que un swap de color no arregla: (1) tipografía real —un display face con carácter más un body face, cargados y aplicados vía escala tipográfica, nunca la fuente del sistema— y (2) un elemento de FIRMA por el que la app se recuerda. Es la pasada de Capa 2 (identidad) sobre los tokens de Capa 1 (estructura) de la fase 1.

## Protocolo

1. **Identidad = edición de valores de tokens, no de pantallas.** Redefine sobre los MISMOS nombres de token de Capa 1: colores, familias de fuente (pairing display/body real), valores del elemento de firma. Aterrizar Capa 2 es un token-value edit, no estructura nueva.
2. **Cambiar la SHAPE es barato acá.** Un cambio compartido (más radio en todos los botones) = una edición de token en `lib/theme.ts`. Un cambio estructural (una variante nueva de Button) = un archivo de primitivo en `components/ui/*`. Las pantallas quedan intactas por construcción.
3. **De-genericizar vive en tipo + firma, no en hex.** Un swap de token de color sobre una estructura genérica sigue siendo genérico. Un fondo casi-blanco/crema lee como "el default de la IA"; la distinción viene de comprometerse con color y tipo.
4. **Presenta 2-4 opciones concretas** de dirección visual; el usuario elige. Nunca impongas una.

## Skills

- `frontend-design` (primaria), `typeset`, `colorize`, `tailwind-4` — si alguna de estas skills no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase; Argos no valida automáticamente disponibilidad de skills externas por fase.

## Cómo verificar el gate

- El usuario confirma que se siente distintiva, no genérica, EN DEVICE.
- El diff toca SOLO `lib/theme.ts` y `components/ui/*`. Cualquier cambio a un archivo de pantalla por styling es fallo de gate: significa que la Capa 2 se filtró a las pantallas en vez de aterrizar como edición de token.

## Artifacts

- `lib/theme.ts` (tokens Capa 2), `components/ui/*`.
- Engram: `app/{app}/phase-5`.

## Modelo

`fable`, effort alto: aquí decide el gusto.

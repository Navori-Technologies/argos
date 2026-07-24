# Fase 3 — Motor de dominio

## Objetivo

La lógica de dominio pura más su wiring de persistencia, cubierta por tests unitarios. Gate mecánico: auto-avanza cuando la evidencia pasa.

## Protocolo

1. **Separa puro de wiring.** El módulo puro (`scoring.ts`) no importa DB ni RN y es unit-testeable; el módulo de wiring (`engine.ts`) conecta la lógica pura a Drizzle. Esta separación es una regla dura de la feature.
2. **El dominio compartido vive en `packages/*`**, para que mobile y web lo reusen (browser-isomorphic). Nunca dupliques una regla de negocio entre app y dashboard: divergen.
3. **Deriva las reglas del documento** (§7). Cada regla de negocio debe ser verificable en código o por observación; escribe un test por cada una.
4. **Queries de Drizzle son lazy** — haz `await` de cada mutación o nunca corre.
5. **Fechas de solo día:** construye desde componentes de fecha local, nunca `toISOString()` (el timezone corre el día).

## Skills

- `verify-before-done` — corre el quality gate en este turno, no lo asumas del informe del subagente.
- `typescript`, `ponytail` — si alguna de estas skills no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase; Argos no valida automáticamente disponibilidad de skills externas por fase.

## Cómo verificar el gate

- Los tests unitarios pasan (incluye un test por regla de negocio del §7).
- `npx tsc --noEmit` limpio.
- La lógica pura no tiene imports de framework ni de IO.

## Artifacts

- `packages/*` (dominio puro compartido), `features/<domain>/engine` (wiring).
- Engram: `app/{app}/phase-3`.

## Modelo

`sonnet`, effort medio.

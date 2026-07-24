# Fase 9 — Docs de entrega

## Objetivo

Un `README.md` y un `DEPLOYMENT.md` anclados al repo real, nunca boilerplate. Gate mecánico: derivados del repo y verificados contra él.

## Protocolo

1. **README.md derivado del repo.** Qué/por qué, arquitectura, layout del monorepo, prerequisitos, setup local, scripts, testing, troubleshooting. Cada dato sale del repo real; nada inventado.
2. **DEPLOYMENT.md como runbook completo.** Referencia de env, runbooks de backend/web/mobile, checklist post-deploy, rollback. Debe ser verificable paso a paso.
3. **Verifica contra el repo.** El README tiene que bootear un clone limpio: si un comando o path no existe en el repo, es un error, no un hueco.

## Skills

- `verify-before-done` — verifica los comandos documentados en este turno, no los asumas.
- `ship-docs`, `cognitive-doc-design` — si alguna de estas skills no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase; Argos no valida automáticamente disponibilidad de skills externas por fase.

## Cómo verificar el gate

- Un clone limpio sigue el README y la app corre.
- `DEPLOYMENT.md` cubre env, deploy y rollback de cada superficie.
- Cero comandos o paths que no existan en el repo.

## Artifacts

- `README.md`, `DEPLOYMENT.md`.
- Engram: `app/{app}/phase-9`.

## Modelo

`sonnet`, effort medio.

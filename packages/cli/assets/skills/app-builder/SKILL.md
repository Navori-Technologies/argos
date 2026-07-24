---
name: app-builder
description: Feature multi-fase que orquesta skills para llevar de la definición de producto a una app publicada en las stores, con un quality gate por fase. Trigger: building a new app from scratch, React Native app, new app from zero, app from scratch, crear una app, app builder, app desde cero.
---

# App Builder — contrato de orquestación

## Rol del orquestador

Eres un COORDINADOR, no un ejecutor. Corres la fase 0 y delegas cada fase siguiente a un subagente; nunca implementas inline. Validas el gate, haces commit, persistes el artifact en Engram (`app/{app}/phase-{n}`) y avanzas. Hablas solo en los gates o ante un bloqueo.

## Reglas duras

1. No escribas código antes de aprobar la fase 0. El documento de producto es el contrato de todo lo que viene.
2. Un solo monorepo, nunca varios repos: `apps/mobile`, `apps/web` y `apps/dashboard` cuando aplican, `apps/site` solo en tier 3, `packages/*` para el dominio compartido.
3. Los gates son bloqueantes y secuenciales: la fase N arranca solo si el gate de la fase N-1 pasó. Nunca reordenes ni saltees fases.
4. El carácter es entregable de la fase 4, no un retoque de la fase 5: tipografía, jerarquía y firma se construyen en gris antes de comprometer color.
5. Para trabajo de UI carga primero la skill de craft más chica que sirva; nunca una skill de limpieza o genérica como primaria.
6. Mantén el dominio puro y cubierto por tests, separado del wiring de persistencia.
7. Commit tras cada chunk de trabajo: conventional commits, sin atribución de IA.
8. Documenta el progreso de cada fase en un lugar durable (Engram u otro registro persistente del repo).

## Tabla de fases

| n | Fase | Objetivo | Gate | Modelo |
|---|------|----------|------|--------|
| 0 | product | Documento de producto + nombre definitivo | El usuario aprueba el documento explícitamente, nombre incluido | fable |
| 1 | scaffold | Monorepo + app booteando en device | Bootea en device real y los primitivos consumen tokens | haiku |
| 2 | data | Schema, migraciones y seed | Typecheck limpio y el seed no duplica | sonnet |
| 3 | domain | Motor de dominio puro + tests | Tests pasan y typecheck limpio | sonnet |
| 4 | ui-nav | Navegación, pantallas core, auth completa, carácter estructural | El usuario recorre todos los flujos y funcionan | sonnet |
| 5 | identity | Color, tipografía característica, elemento de firma | El usuario confirma que se siente distintiva en device | fable |
| 6 | polish | Microinteracciones, movimiento, háptica | Verificado en device real | fable |
| 7 | brand | Concepto de logo + assets derivados | El usuario elige un concepto; assets verificados en dev build | fable |
| 8 | web | Páginas públicas según jerarquía de tres tiers | URLs públicas (privacy + support) live y válidas | sonnet |
| 9 | docs | README.md + DEPLOYMENT.md | README bootea un clone limpio; runbook completo | sonnet |
| 10 | store | Submission a stores como código | `eas submit` OK en ambas stores + checklist manual entregado | sonnet |

El detalle completo de cada fase (objetivo, protocolo, skills, cómo verificar el gate, artifacts, modelo) vive en `phases/<n>-<slug>.md` — por ejemplo `phases/0-product.md` o `phases/4-ui-nav.md` — y se carga recién cuando esa fase corre, nunca todas de entrada.

## Result contract

Cada subagente de fase devuelve: `status` (done | partial | blocked), `executive_summary`, `artifacts`, `gate_evidence`, `risks`, `skill_resolution`. Antes de avanzar a la fase siguiente, el orquestador valida el contrato completo, la existencia real de los artifacts declarados, cero alucinación y cero drift contra el documento de producto.

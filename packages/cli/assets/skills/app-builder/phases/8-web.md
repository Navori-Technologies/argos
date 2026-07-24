# Fase 8 — App web

## Objetivo

Páginas públicas de compliance (privacy + support OBLIGATORIAS; landing pitch opcional) live y válidas para App Store Connect. La decisión clave es qué tier construir.

## Jerarquía de tres tiers — elige el PRIMER tier que aplique

1. **El producto tiene web app (`apps/web`) → dobla las páginas públicas adentro** como rutas públicas: un solo codebase/deploy, reusa shadcn + tokens. La web app hereda los packages de dominio/datos compartidos (browser-isomorphic), así que es sobre todo un proyecto de UI. Orquesta con foundation-then-slices: un agente FOUNDATION secuencial (modelo top) que instala TODO, porta el design system y arma el shell + router con cada ruta pre-registrada; luego agentes FEATURE en PARALELO (sonnet) que espejan pantallas mobile, cada uno dueño de carpetas de ruta DISJUNTAS, sin npm installs ni edición de archivos compartidos; luego un review gate.
2. **No hay web app, pero existe un dashboard (`apps/dashboard`) → agrega privacy/support como rutas PÚBLICAS en el dashboard.** Las rutas viven FUERA del auth gate y el deployment las sirve públicas. NADA de un Astro aparte: un site separado junto a un dashboard existente es infraestructura innecesaria. Despliega el dashboard si aún no lo está (ese deploy vale por sí solo). El dashboard es su propia app (React 19 + Vite + shadcn, registro restringido).
3. **Ni web app ni dashboard → site estático mínimo Astro (`apps/site`).**

## Skills

- `astro-islands` (solo tier 3), `review-diff` (review gate de consistencia; esta skill ya existe en este motor y es directamente resoluble) — mapeados al catálogo.
- `app-ia`, `dashboard-ia` (tier 2), `react-19`, `tailwind-4`, `frontend-design` — si alguna de estas skills no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase; Argos no valida automáticamente disponibilidad de skills externas por fase.

## Cómo verificar el gate

- URLs públicas de privacy y support devuelven HTTP 200 SIN auth (verifica con `curl -I`, no con un browser logueado).
- Para deploys en Vercel: SSO deployment protection OFF en páginas públicas, Root Directory apuntando a la app correcta, alias no stale.

## Artifacts

- Según tier: `apps/web` (rutas públicas) | rutas públicas en el dashboard | `apps/site`.
- Engram: `app/{app}/phase-8`.

## Modelo

`sonnet`, effort alto: la orquestación del fan-out decide la calidad.

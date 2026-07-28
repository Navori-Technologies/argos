# Fase 0 — Producto

## Objetivo

Un documento de definición de producto aprobado por el usuario, con el nombre definitivo de la app decidido. Es el contrato de todo lo que se construye después: no se escribe código hasta que esté aprobado.

## Protocolo

1. **Ronda de preguntas batched PRIMERO.** Antes de redactar nada, haz UNA sola ronda de preguntas que cubra las decisiones que dan forma al documento: profundidad del motor, estrategia de contenido, límites de alcance, audiencia, y si el producto tiene dos lados (usuarios que consumen datos y staff que los administra → posible `apps/dashboard`). Nunca redactes el documento desde la idea cruda.
2. **Documenta desde este scaffold.** Usa como base el siguiente esqueleto mínimo (es un punto de partida, no un tutorial):

   ```markdown
   # Definición de producto — <nombre de la app>

   ## Pitch (una línea)
   <qué hace la app, en una oración>

   ## Usuario objetivo
   <quién la usa y qué problema le resuelve>

   ## Core loop
   <el ciclo de uso principal, paso a paso>

   ## Features must-have (v1)
   - <feature 1>
   - <feature 2>

   ## No-goals explícitos
   - <qué queda deliberadamente afuera de v1>

   ## Nombre y marca
   <nombre definitivo, tono de marca, referencias>
   ```

   La sección de nombre y marca es parte del documento, no un paso aparte — pero el nombre NUNCA lo eliges tú: antes de redactar, presenta un brief de 2–4 nombres candidatos (significado + racional) y deja que el usuario elija o contraproponga; el documento se redacta con el nombre elegido. Apunta a un máximo de 2 iteraciones del documento (economía de tokens).
3. **Gate: aprobación explícita CON nombre definitivo.** No avances al scaffold sin que el usuario apruebe el documento y confirme el nombre definitivo. El nombre definitivo es un artifact declarado de esta fase y parte de su gate.
4. **Sincroniza el nombre al config.** Al cerrar la fase, guarda el nombre definitivo en el campo `name` de `argos.config.json` del repo (o ejecuta `argos adopt --refresh` si el detector automático ya puede inferirlo una vez creado el repo). Renombrar la carpeta es opcional y cosmético; nada del motor depende del basename después del init.

## Skills

- `cognitive-doc-design` — carga al redactar el documento para reducir la carga cognitiva del lector. Si esta skill no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase — Argos no valida automáticamente disponibilidad de skills externas por fase.

## Cómo verificar el gate

- El usuario dice explícitamente que aprueba el documento.
- El documento incluye la sección de nombre y marca con el nombre definitivo.
- `docs/product-definition.md` existe en el repo.
- El campo `name` de `argos.config.json` quedó actualizado con el nombre definitivo (a mano o vía `argos adopt --refresh`).

## Artifacts

- `docs/product-definition.md` — siempre vive en el repo, cualquiera sea el store.
- `name` definitivo en el campo `name` de `argos.config.json`.
- Engram: `app/{app}/phase-0` (decisiones y nombre bloqueados).

## Modelo

`fable` (Fable si está disponible, si no Opus), effort alto: la fase la decide el juicio, no la mecánica.

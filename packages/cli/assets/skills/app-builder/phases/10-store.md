# Fase 10 — Store ship

## Objetivo

La submission a las stores como código, hasta que `eas submit` corre en ambas y el checklist manual queda entregado.

## Prerequisitos duros

- **Metadata copy deriva del documento de producto (fase 0).** Nunca inventes el pitch de store.
- **URLs de privacy/support vienen de la fase 8.** Sin ellas la submission de App Store Connect no cierra.

Ambos son prerequisitos duros: verifica que existan antes de arrancar.

## Protocolo

1. **`store/` como código.** Metadata de iOS vía `eas metadata`, árbol supply de Play, screenshots.
2. **`eas.json`** con perfiles de build y submit.
3. **Screenshots con Maestro** corridos contra data demo seeded, en la matriz de devices requerida.
4. **Build y submit.** `eas build` + `eas submit` a TestFlight / track interno de Play.
5. **Checklist manual explícito.** App Privacy y content-rating questionnaires, primer upload de AAB en Play, cuenta demo para review. Las submissions corren en las cuentas de store del usuario.

## Skills

- `store-ship` — envuelve EAS build/submit, metadata as code y screenshots Maestro. Si esta skill no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase; Argos no valida automáticamente disponibilidad de skills externas por fase.

La fase opcional de video promocional de la skill de origen queda fuera de v1; se retoma como iteración posterior si el usuario la pide.

## Cómo verificar el gate

- `eas submit` OK en ambas stores: build visible en TestFlight, release creado en el track interno de Play.
- El checklist manual está entregado al usuario.

## Artifacts

- `store/` (metadata iOS + Play), `eas.json`, flujos Maestro de screenshots.
- Engram: `app/{app}/phase-10`.

## Modelo

`sonnet`, effort medio.

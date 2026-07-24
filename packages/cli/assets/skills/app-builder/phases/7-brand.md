# Fase 7 — Marca

## Objetivo

Un concepto de logo elegido por el usuario y todos los assets de marca derivados de esa marca, con un boot loader que unifica la experiencia de arranque.

## Protocolo

1. **Concepto primero, assets después.** Presenta 3 conceptos escritos de logo (mark/símbolo, tipografía, paleta desde los tokens de la app, rationale de cada uno). El usuario elige uno. El asset final del mark sale de una herramienta de imagen o diseñador: los SVG autorados por LLM tienen un techo de calidad duro. Esta fase deriva assets del mark, no lo inventa.
2. **Normaliza el vector a los tokens** de la app antes de derivar nada.
3. **Deriva del mark elegido:** app icon, set adaptive de Android (foreground dentro del círculo seguro 66%, fondo sólido, monocromo blanco para íconos tematizados), splash vía el mecanismo de la plataforma (transparente, imageWidth fijo, fondo de token), favicon.
4. **Boot loader continuo.** Un boot loader in-app que renderiza la misma composición del splash (mismo asset, mismo ancho, mismo fondo) reemplazando todo spinner del boot path, para que splash nativo → fuentes → sesión → primera pantalla lea como una sola pantalla. Si el mark es simple (plano, icónico), reemplaza TODOS los spinners full-screen con el mark en un breathing loop sutil (escala ~1→1.05, ~1.8s, arranca en reposo, honra reduce-motion). Deja spinners planos solo para estados de control inline (dentro de botones).

## Skills

- `frontend-design` — si esta skill no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase; Argos no valida automáticamente disponibilidad de skills externas por fase.

## Cómo verificar el gate

- El usuario elige un concepto.
- Assets en su lugar y typecheck limpio.
- Splash/icon verificados en un dev build real (Expo Go no muestra splash/icon nativos).

## Artifacts

- `assets/` (icono, adaptive, splash, favicon), boot loader compartido.
- Engram: `app/{app}/phase-7`.

## Modelo

`fable`, effort medio.

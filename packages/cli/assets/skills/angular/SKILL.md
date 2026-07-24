---
name: angular
description: Angular patterns covering standalone components, signals, inject(), native control flow, and zoneless change detection; Signal Forms and Reactive Forms; project structure via the Scope Rule and file naming; and performance via NgOptimizedImage, @defer, lazy routes, and SSR. Trigger: When creating Angular components, working with forms, structuring an Angular app, or optimizing Angular performance.
---

## Orientation

This skill assumes modern Angular: **standalone components** (no `standalone: true` flag needed), **signals** for state, **inject()** over constructor injection, native **`@if`/`@for`/`@switch`** control flow, and **zoneless** change detection (no `zone.js`). RxJS is used only where signals don't fit (combining streams, debounce/throttle, race conditions, websockets).

## Index

| Reference | Covers |
|-----------|--------|
| [references/core.md](references/core.md) | Standalone components, `input`/`output`/`model`, signals, no lifecycle hooks, `inject()`, control flow, RxJS-vs-signals, zoneless setup |
| [references/forms.md](references/forms.md) | Signal Forms (experimental) vs Reactive Forms vs template-driven, nested forms/`FormArray` |
| [references/architecture.md](references/architecture.md) | The Scope Rule, project structure, file naming (no `.component`/`.service` suffixes), style guide, CLI commands |
| [references/performance.md](references/performance.md) | `NgOptimizedImage`, `@defer`, lazy routes, SSR/hydration, slow computations |

Read the reference file(s) relevant to the task at hand before writing Angular code.

---
name: review-diff
description: Checklist de code review por dimensiones agnósticas al stack (tipos, capa de datos, errores, seguridad, hardcode, naming, dead code, quality gate) con severidades CRÍTICO/ALTO/MEDIO. Trigger: revisar un diff staged, una branch contra su rama base, o un PR puntual.
---

# Code review — checklist de un diff

Aplica esta checklist a un diff (staged, branch vs la rama base del repo, o un PR puntual). El esqueleto es agnóstico al stack. Las reglas bespoke de un repo (patrones de su UI lib, convenciones de su capa de datos, anti-patterns propios) no se editan en este skill — viven en la ficha del repo (CLAUDE.md delgado) o en `argos.config.json`, y se leen en runtime.

## Cómo reportar

Una línea por hallazgo, ordenadas CRÍTICO → ALTO → MEDIO:

```
[CRÍTICO] <archivo>:<línea> — <descripción concreta y verificable>
[ALTO]    <archivo>:<línea> — <descripción>
[MEDIO]   <archivo>:<línea> — <descripción>
```

- **CRÍTICO** — rompe build, corrompe data, agujero de seguridad, contrato que no compila. *Bloquea el merge.*
- **ALTO** — bug funcional probable, regresión, error no manejado visible al usuario, violación dura de una convención del repo. *Bloquea el merge.*
- **MEDIO** — legibilidad, naming, doc faltante, hardcode menor, dead code. *No bloquea; se lista.*

Si no llega a MEDIO, no lo reportes. Nada de "nitpick" ni "consider also". (Mapea al `reviewer`: CRÍTICO/ALTO = confidence ≥80, bloquean; MEDIO = observación informativa 50-79.)

## 0. Pre-pasada (antes de leer línea por línea)

- ¿El diff toca infra/config (`tsconfig*`, config de lint/build, `.env*`, CI, `settings.json`)? Flag → validar que el cambio es intencional.
- ¿Borra archivos? Verifica que no queden imports residuales (`grep -rn "<archivo>"`).
- ¿Mezcla cambios no relacionados (feature + refactor + format-only)? → MEDIO, pide separar.

## 1. Tipos y contratos

- `any` explícito en código nuevo sin justificación (`// any justificado: <razón>`) → ALTO.
- Cast (`as Foo`) sin razón documentada → MEDIO; cast que oculta un tipo que en realidad no calza → CRÍTICO.
- Tipo/interface desactualizado vs lo que el código consume (accede a un campo que el tipo no declara) → CRÍTICO.
- Datos externos (respuesta de red, input de usuario, env) consumidos sin validar ni normalizar → ALTO.

## 2. Capa de datos / lógica

- Defaults explícitos para nullables que el consumidor usa directo (`?? …`) → ALTO si falta.
- Funciones que deberían ser puras (transformadores/adapters) con side-effects (I/O, estado global) → CRÍTICO.
- Valor de fuente externa (status/enum desconocido) asignado crudo a un tipo cerrado → ALTO.

## 3. Manejo de errores

- `catch` que se traga el error sin propagar ni reportar → ALTO.
- Operación que puede fallar (red, parse, IO) sin manejo, con el fallo visible al usuario → ALTO.
- Loading/spinner que nunca se apaga en el path de error → ALTO.

## 4. Seguridad y autorización

- Secretos/tokens/credenciales en código (no en config/env) → CRÍTICO.
- Decisión de autorización solo en el cliente, sin validación del backend → ALTO.
- Datos sensibles en storage del cliente más allá de lo necesario → ALTO.

## 5. Sin hardcode

- URLs de API / endpoints literales en vez del canal de config del repo → CRÍTICO.
- Strings de estado/rol o listas de opciones duplicadas en vez de derivarlas de una fuente única → MEDIO.
- Fechas/formatos armados a mano en vez del util del repo → MEDIO.

## 6. Naming y estructura

- Archivo en la carpeta equivocada según la convención del repo (componente compartido en `pages/`, etc.) → ALTO.
- Casing/sufijos que rompen la convención del repo → MEDIO.
- Convención de migración rota (cuando conviven código nuevo y legacy y hay un sufijo/carpeta esperado) → ALTO.

## 7. Dead code y debug

- `console.log` / print de debug sin guard en código que se mergea → MEDIO (en código nuevo: ALTO).
- Imports o variables sin usar → MEDIO.
- Código comentado entero / `if (false)` / `// TODO: borrar` sin issue → MEDIO.

## 8. Quality gate (corrido en este turno, no asumido)

- El quality gate fast del repo pasa → CRÍTICO si falla. El comando concreto no vive en este skill: resuélvelo leyendo `qualityGate.fast` en el `argos.config.json` del repo o su ficha (CLAUDE.md delgado).
- Cero errores/warnings nuevos vs baseline → ALTO si el diff los agrega.

## 9. Commit y PR

- Commits siguen la convención del repo → MEDIO si rompe.
- Cambios a manifest/lockfile sin razón clara en la descripción → ALTO.

## Áreas críticas

Presta atención extra si el diff toca las áreas críticas que declara el repo (`project.criticalAreas` en su `argos.config.json`, resuelto también en la ficha). Un hallazgo en esas zonas sube un nivel de severidad.

## Output

1. Lista plana con severidades, ordenada CRÍTICO → ALTO → MEDIO. Cada línea con `archivo:línea`.
2. Si no hay hallazgos: `Sin observaciones.`
3. Nada de resumen, "good job", ni sugerencias fuera del checklist.
4. Si encuentras un patrón de bug nuevo que no está aquí, guárdalo (memoria / nota) para próximas reviews.

## Conexión con el harness

- `reviewer`: aplica este skill en la Pasada 2 (code quality). CRÍTICO/ALTO mapean a issues con confidence ≥80 (bloquean APPROVED); MEDIO a observaciones informativas (50-79).
- `verify-before-done`: el quality gate del §8 se corre en este turno, no se asume del informe del implementer.

Este skill vive una sola vez en el motor global y aplica a cualquier repo con `argos.config.json`. Las reglas bespoke de un stack/dominio concreto (componentes prohibidos de una UI lib, headers obligatorios de un cliente HTTP, reglas de forms propias, anti-patterns auto-CRÍTICO del repo) no se agregan a este archivo: van en la ficha del repo o en la config, y se leen en runtime al revisar ese repo específico.

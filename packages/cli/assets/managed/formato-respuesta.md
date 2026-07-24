## Concisión (aplica a todo: chat y subagentes)

- Lidera con el resultado: la primera línea responde "qué pasó / qué encontré", no el preámbulo.
- Cero relleno: no narres acciones de rutina ("ahora voy a…", "déjame ver…", "perfecto, entonces…") ni cierres de cortesía.
- Recorta la prosa, no la sustancia. Legible > telegráfico: frases completas, sin cadenas de flechas ni jerga inventada.
- Código, comandos, paths y mensajes de error: **intactos**, nunca los abrevies ni los parafrasees.
- Por defecto breve; si el operador pide detalle, o el problema lo exige (causa raíz no obvia, tradeoffs reales), expande.
- Una pregunta a la vez: si falta un dato para seguir, haz UNA sola pregunta puntual y espera la respuesta antes de continuar — no la mezcles con más preguntas ni la disfraces de menú de opciones.

## Formato de respuesta

**Bug fix** (sin intro ni cierre):
CAUSA: <1 línea> / ARCHIVO: <path>:<línea> / FIX: <diff mínimo>

**Code review**:
[CRÍTICO] ... # rompe build, security o pérdida de datos
[ALTO]    ... # bug funcional, regresión
[MEDIO]   ... # legibilidad, naming

**Generación**: diff si modifica; archivo completo solo si es nuevo.
**Commits**: Conventional (`feat(scope): ...`), español MX, atómicos.

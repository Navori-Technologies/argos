---
name: verify-before-done
description: Aplica la Iron Law de verificación antes de declarar cualquier tarea lista — exige evidencia fresca del comando que respalda el claim, nunca inferencia. Trigger: antes de decir listo/done/completed/approved, antes de un commit o PR, o cuando un subagente reporta éxito sin que se haya visto el diff.
---

# Verify Before Done

## La ley de hierro

```
NINGÚN CLAIM DE COMPLETADO SIN EVIDENCIA DE VERIFICACIÓN FRESCA
```

Si no corriste el comando de verificación EN ESTE TURNO, no puedes afirmar el claim. "Debería funcionar", "la corrida anterior estaba verde", "se ve bien" NO son evidencia.

## Por qué este skill existe

El bug recurrente es declarar "listo" en base a inferencia:

- "corrí el check hace 2 cambios atrás, debería seguir verde"
- "el código compila, la UI debería andar"
- "el adapter está bien, el render debe funcionar"

Inferencia ≠ evidencia. Este skill fuerza el rigor.

## Función de gate

ANTES de afirmar cualquier "listo / done / completed / approved":

1. **IDENTIFY**: ¿qué comando prueba este claim?
2. **RUN**: ejecuta el comando COMPLETO en este turno (no parcial, no cached).
3. **READ**: output completo, exit code, contar failures.
4. **VERIFY**: ¿el output confirma el claim?
   - NO → declara el estado real con evidencia.
   - SÍ → afirma el claim CON la evidencia visible.
5. **ONLY THEN**: haz el claim.

Saltarse cualquier step = mentira, no verificación.

El comando exacto de cada claim (qué es "fast" y qué es "full") no vive en este skill: se resuelve en runtime leyendo `qualityGate.fast` / `qualityGate.full` en el `argos.config.json` del repo, o la ficha (CLAUDE.md delgado) que `argos adopt` escribió con esos hechos ya resueltos en texto literal. Si el repo no tiene config ni ficha, no asumas un comando — pregunta o revisa `package.json` / scripts del repo antes de declarar nada verde.

## Tabla claim → output requerido → no alcanza

| Claim | Output requerido | No alcanza |
|---|---|---|
| Quality gate fast verde | Comando fast del repo (resuelto desde `argos.config.json`/ficha) corrido completo en este turno con exit 0 | "corrí antes", "debería estar verde", "lint pasaba ayer" |
| Quality gate full verde | Comando full del repo (mismo origen) — exit 0 fresco en este turno | "el dev server anda", "build pasó hace rato" |
| Cero errores nuevos vs baseline | `git stash` → re-run → comparar conteos → `git stash pop` | "lint dijo OK" sin comparar baseline |
| UI validada (golden path) | Repro step + comportamiento observado en navegador con dev server vivo en este turno | "se ve bien en código", "debería renderizar bien" |
| Bug arreglado | Reproducir síntoma original y verlo NO ocurrir | "cambié el código, asumí que quedó arreglado", "el diff cubre el caso" |
| Filtro / feature funciona | Click real + descripción del resultado | "el handler está bien escrito" |
| Migración estructural completa | Lectura Y escritura van al mismo destino en el flujo afectado, validado en navegador o test | "cambié el service, debería andar" |
| PR creable | Pre-flight verde (status limpio, no estás en la rama base ni en la rama destino del PR — `branchBase`/`prTarget` de `argos.config.json` —, `gh` auth ok, quality gate verde) EN ESTE TURNO | "el branch tiene commits, podemos crear" |
| Tests pasan | Suite corrida fresca con exit 0 en este turno + conteo de tests | "no tocamos tests", "deberían seguir verdes" |
| Type-check limpio | `tsc --noEmit` (o el check equivalente que declare el stack del repo) exit 0 en este turno | "TS no se quejó cuando lo guardé" |

## Señales de alerta (PARA)

- Estás por escribir "listo" / "done" / "perfect" / "should work".
- Estás por hacer `git commit` sin haber corrido el quality gate fast del repo en este turno.
- Estás por marcar `APPROVED` un review sin haber leído el diff completo.
- Estás cansado y quieres cerrar.
- "Solo por esta vez" — NO. Cero excepciones.
- Confías en el reporte de un subagente sin verificar el diff tú mismo.

## Prevención de racionalización

| Excusa | Realidad |
|---|---|
| "Tengo confianza" | Confianza ≠ evidencia. |
| "Si compila, anda" | TS con `strict: false` no atrapa undefined runtime. Verifica UI / runtime. |
| "El check pasó hace 10 min" | Re-corre. Fresca. |
| "Es trivial, no hace falta" | Trivialidad no exime de verificación. |
| "El subagente dijo done" | Mira el diff tú mismo. Confía, pero verifica. |
| "El usuario tiene prisa" | Prisa ≠ excusa. Verificación rápida es más rápida que rollback. |
| "Mismo argumento con otras palabras = la regla no aplica" | El espíritu de la regla importa más que la letra. |

## Cuándo se invoca este skill

- **`implementer`**: antes de devolver `done -> .claude/progress/impl_<feature>.md`. Antes de pasar al `reviewer`.
- **`reviewer`**: antes de marcar `APPROVED`.
- **`commit-pr-pilot`**: antes de `gh pr create`.
- **Cualquier agent**: antes de decir "listo" al usuario en cualquier respuesta de tarea de código.

## Conexión con el resto del harness

- El CLAUDE.md global menciona el quality gate en su sección de cierre. Este skill añade rigor de "evidencia fresca" + cubre dimensiones UI / bug arreglado que el quality gate no toca por sí solo.
- El `implementer` referencia este skill en su "Evidence-based completion".
- El `reviewer` debe citar este skill cuando marca `APPROVED`.
- El `commit-pr-pilot` lo aplica en su pre-flight antes de tocar `gh`.

## Anti-patrones

- ❌ Mostrar output cacheado de hace 5 mensajes y decir "ya está verde" — evidencia fresca, no cacheada.
- ❌ Inferir UI desde el código — la UI necesita repro en navegador.
- ❌ "Confía en mí, anda en mi máquina" — no es claim válido sin evidencia en el chat.
- ❌ Hacer el claim ANTES del comando ("voy a correr X y debería estar verde").
- ❌ Marcar `[x]` un step del plan atómico sin haber corrido la verificación que respalda ese step.
- ❌ Aceptar el reporte de un subagente sin abrir el diff y validar al menos los archivos críticos.

## Cierre

Skill **siempre activa** durante cualquier flow de implementación. No requiere invocación explícita — es principio que aplica a todo claim de "listo".

Al aplicarla, el output al usuario debe incluir:

1. El claim explícito (qué se logró).
2. El output completo (o referencia al comando corrido) que lo respalda.
3. Si algún sub-claim NO pudo verificarse (ej. UI sin browser disponible), decirlo EXPLÍCITO — no inferir.

Este skill vive una sola vez en el motor global (`~/.claude/skills/`) y se aplica a cualquier repo. Los checks específicos de un proyecto (comandos que cuentan como evidencia válida, patrones de bug donde la inferencia históricamente falló, áreas críticas con verificación propia) no se editan aquí: viven en la ficha del repo (CLAUDE.md delgado) o en `project.criticalAreas` de su `argos.config.json`, y se leen en runtime al trabajar en ese repo.

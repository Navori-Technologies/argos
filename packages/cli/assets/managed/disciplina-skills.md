## Disparo de skills (disciplina obligatoria)

Antes de responder a CUALQUIER pedido, corre este self-check: ¿el pedido matchea el trigger de algún skill instalado? Cada skill declara su disparador en su descripción.

- Si matchea → invoca el skill con la tool `Skill` ANTES de generar la respuesta. Es un requisito bloqueante, no contexto opcional; saltarlo es una falla de disciplina.
- Matchea por contexto de archivos (extensiones, paths, stack del repo según su ficha) y por contexto de tarea (lo que el usuario pide). Pueden aplicar varios skills a la vez.
- Un comando slash del usuario (`/nombre`) es mandato directo: invócalo siempre.
- Usa nombres exactos del catálogo; nunca inventes ni adivines un nombre de skill.
- Si el contenido del skill ya está cargado en este turno, no lo re-invoques.
- La ficha del repo lista los skills aplicables a su stack — es la primera pista de qué skills revisar al trabajar en ese repo.
- En la duda entre "lo resuelvo solo" y "hay un skill para esto": el skill gana. Encapsula oficio probado; ignorarlo es rehacer el trabajo peor.

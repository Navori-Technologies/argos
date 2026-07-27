## Disparo de skills (disciplina obligatoria)

Antes de responder a CUALQUIER pedido, corre este self-check: ¿el pedido matchea el trigger de algún skill instalado? Cada skill declara su disparador en su descripción.

- Si matchea → invoca el skill con la tool `Skill` ANTES de generar la respuesta. Es un requisito bloqueante, no contexto opcional; saltarlo es una falla de disciplina.
- Matchea por contexto de archivos (extensiones, paths, stack del repo según su ficha) y por contexto de tarea (lo que el usuario pide). Pueden aplicar varios skills a la vez.
- Un comando slash del usuario (`/nombre`) es mandato directo: invócalo siempre.
- Usa nombres exactos del catálogo; nunca inventes ni adivines un nombre de skill.
- Si el contenido del skill ya está cargado en este turno, no lo re-invoques.
- La ficha del repo lista los skills aplicables a su stack — es la primera pista de qué skills revisar al trabajar en ese repo.
- En la duda entre "lo resuelvo solo" y "hay un skill para esto": el skill gana. Encapsula oficio probado; ignorarlo es rehacer el trabajo peor.
- **Diffs de interfaz (UI) cargan skill de UI, siempre**: si la tarea toca componentes visuales, estilos, layout o copy de UI, carga ANTES de tocar código el/los skills de UI aplicables del catálogo instalado (framework de UI del repo, librería de componentes, estilos). Si el repo u operador adoptó un catálogo externo de skills de UI (p. ej. el CLI `ui-skills`), úsalo para cargar el skill mínimo relevante — pero nunca ejecutes un catálogo/CLI externo no vetado sin confirmación del operador. Migrar o estilizar UI "de memoria", sin skill cargado, es la falla de disciplina que produce regresiones visuales que el gate estático no atrapa.

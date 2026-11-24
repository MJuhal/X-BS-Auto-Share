# Rule34 (rule34.xxx)

Alcance: **investigar y medir** por la API oficial con la cuenta de marca y **asistente de subida**: la IA prepara cada post (imagen limpia, título, etiquetas, rating, source y agenda, `herramientas/rule34-subidas.mjs` y la sección Subidas del panel) y **la persona a cargo publica siempre a mano** desde el formulario web. La API no permite subir y nunca se automatiza el formulario. La IA nunca comenta, vota, da favoritos ni sigue, y no esquiva el bloqueo de la web a la lectura automática.

Fuentes: la documentación de la API, las reglas extendidas de IA, los Términos de Servicio y el FAQ del foro. la persona a cargo los pegó el 2026-11-19.

## API

- Base: `https://api.rule34.xxx/index.php?page=dapi&q=index`.
- Pide `api_key` y `user_id`. Van en el archivo de claves (`rule34_api_key`, `rule34_user_id`) y se cargan desde el panel.
- **Una sola key por persona:** usar varias suspende la key o la cuenta.
- **Prohibido mostrar su contenido** con publicidad o detrás de un muro de pago.
- Es de solo lectura:
  - posts: `s=post`, con `tags` (cualquier búsqueda de la web, incluidas las meta-etiquetas), `limit` (máximo 1000), `pid`, `json=1` y `fields=tag_info` (tipo de cada etiqueta);
  - posts borrados: `deleted=show&last_id=`;
  - comentarios: `s=comment&post_id=`, que devuelve XML;
  - etiquetas: `s=tag`;
  - autocompletado: `/autocomplete.php?q=`.
- No hay endpoint para subir.
- Si falta la key, la API responde HTTP 200 con el error en el texto ("Missing authentication").
- Los límites de uso no están publicados y pueden cambiar.
- **Para medir:** el puntaje solo suma, porque no hay votos negativos. Los favoritos no se pueden consultar.
- Código: `herramientas/rule34.mjs` y la pestaña Rule34 del panel.

## Reglas que importan para la marca

**IA (reglas extendidas, más estrictas que las generales):**
- **Sin marca de agua, firma, link ni logo en la imagen.** Rige desde agosto de 2026, sin excepciones. Tampoco vale tapar o borrar una marca con IA.
- Siempre la etiqueta `ai_generated` y al menos 10 etiquetas buenas.
- Máximo 100 subidas por día, y lo recomendado es mucho menos: solo lo mejor.
- Nada repetitivo (series con variaciones mínimas) ni collages de más de 3 imágenes.
- **Nada que parezca menor:** ni personas bajas, "petite" o chibi, ni anatomía joven. Es motivo de ban y borrado de la cuenta. En LoL, nada de yordles.
- Prohibido imitar el estilo de un artista o usar etiquetas de artista en el prompt: ban permanente. la persona a cargo confirmó que sus prompts no usan etiquetas de artistas.
- Ni personas reales ni nombres reales en las etiquetas. Nada fotorrealista que pueda pasar por foto.
- Tiene que ser porno: un escote solo no alcanza ("NP = not porn").
- Anatomía y ropa correctas, sin partes pegadas ni deformes. Sin censura.
- Nada de fetiches de nicho ni animales reales.
- Lo que se sube no se puede borrar después: es un archivo.

**Generales:**
- Mínimo 500 px de lado para IA y sin reescalados.
- **Prohibidos los adelantos, las versiones censuradas y "más en mi Patreon":** solo se suben obras completas.
- El contenido pago no se publica, salvo que el artista lo libere.
- Links:
  - solo al sitio original del artista;
  - el **source tiene que apuntar a la página exacta de esa imagen**, nunca a una portada o categoría;
  - el source tiene que ser el original: no se puede cambiar por el sitio de quien sube.
- El artista puede dejar el link a su página en los comentarios de **sus propias obras**, y solo ahí.
- Comentarios solo en inglés y sin promoción. Prohibido pedir que te contacten o dar Discord o redes. No se permiten temas personales en el foro.
- Para crear la etiqueta de artista hay que pedírsela a un moderador, con links a obras ya subidas y al perfil del artista en otra red.

## Cómo llevar gente a Patreon (si se autoriza publicar)

**En Patreon no se puede publicar gratis contenido explícito** [Cierto, actualización de políticas de Patreon del cuarto trimestre de 2025]: las obras con desnudos o sexo tienen que quedar detrás del muro de pago, solo para miembros que pagan. Así que un post público de Patreon no sirve como source de una imagen explícita.

Lo que sí se puede:
- **Link en los comentarios:** el artista puede dejar el link a su página en los comentarios de sus propias obras (FAQ 63). Es la vía directa a Patreon y está permitida.
- **Una galería propia como source** [Probable]: una página de la marca (dominio propio) con esa imagen y un botón a Patreon. Es el "sitio original del artista" que piden las reglas. Necesita aviso de mayoría de edad.
- **X con la imagen explícita** (marcada como contenido sensible) como source: cambia la estrategia de la cuenta de marca, que hoy es sugerente sin desnudos. Lo decide la persona a cargo.
- **Pixiv R-18:** Pixiv exige censura con mosaico y Rule34 no acepta IA censurada, así que la versión de Pixiv no sería la misma imagen. Dudoso.

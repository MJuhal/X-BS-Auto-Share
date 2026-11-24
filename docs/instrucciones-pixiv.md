# Instrucciones para escribir un lote de posts de Pixiv

Sos quien escribe los posts de Pixiv de la marca (cuenta "la marca"). Cada post son **3 imágenes del mismo personaje** + título + descripción + etiquetas. El objetivo es que quien lo vea sienta curiosidad por lo que no se muestra y entre al perfil, donde está el link a Patreon. Ahí manda Patreon: lo que se publica en Pixiv es la vidriera SFW de los packs.

Leé primero `docs/instrucciones-lote.md` (la voz de la marca, la personalidad de cada personaje y los límites). Valen igual, con las diferencias de esta página.

## Qué cambia respecto de X

- **El personaje SÍ se nombra** (en Pixiv la gente busca por personaje y por juego). Las etiquetas del personaje y de League of Legends las pone el sistema solo: vos no las escribís.
- **No hay links ni la palabra "Patreon".** La invitación es al perfil: "full set in my profile", "the rest lives behind the link in my profile", "link in profile 🎀". El link a Patreon ya está en el perfil.
- **Nada de engagement bait:** no pedir follows, likes ni marcadores ("follow me", "like if", "bookmark if"). La invitación es solo al perfil.
- **Sin hashtags dentro del texto** (las etiquetas van aparte).
- **Las imágenes son de IA:** el sistema marca cada obra como "AI-generated" en Pixiv. No lo escondas ni lo niegues en el texto.

## Qué escribir en cada pieza

Abrí las 3 imágenes de la pieza antes de escribir (rutas en `imagenes[].archivo`, dentro de la carpeta del lote).

- `personaje`: el campeón que muestran las imágenes, en minúscula, tal como figura en el nombre del archivo (`aurora`, `nami`, `leblanc`...). Si alguna de las 3 no es el mismo personaje, avisalo en `alerta`.
- `titulo`: hasta 32 caracteres, en inglés, corto y con gancho. Puede llevar el nombre del personaje. Ejemplos: `Aurora, after midnight` · `Nami, off duty` · `Evelynn sets the rules`. No repitas títulos de los posts anteriores.
- `descripcion`: en inglés, 2 a 4 líneas cortas con la voz del creador (como en X: el creador muestra lo que le salió, lo que le provoca y lo que imagina; doble sentido sutil, nada explícito). Acá puede nombrarla. Última línea: la invitación al perfil, variada. 0 a 2 emojis. Ejemplo:
  ```
  spent the whole night on this set of Aurora and I still can't pick a favorite ✨
  something about the way she looks back at the camera. I keep imagining what happens next.
  the rest of the set, the less calm ones, are in my profile 🙈
  ```
- `etiquetas_extra`: hasta 3 etiquetas descriptivas que encajen con las imágenes, elegidas de la lista `descriptivas` de `docs/pixiv-etiquetas.json` (preferí las japonesas). Nada que sugiera juventud (`少女`, `ロリ`, `JK`, `制服`, `学生`, etc.).
- `sugerente`: `true` o `false`. Es la respuesta a la pregunta obligatoria de Pixiv **"Adult content"** (en obras "All ages"): `true` = "Included (slightly sexual or suggestive content)", y Pixiv la clasifica como sensible; `false` = "No". Decidilo mirando las 3 imágenes, según las reglas de Pixiv. La idea es clasificar bien, sin pasarse de vivo:
  - `true` si **alguna** de las 3 tiene: escote o pecho como foco de la imagen; cola, entrepierna o muslos como foco; ropa muy reveladora (cobertura tipo bikini, ropa ajustada que marca, ropa rasgada o abierta); ropa interior o lencería a la vista; poses sugerentes (en cuatro, inclinada mostrando la cola, piernas abiertas, arqueada, recostada en actitud seductora, en la cama); expresión o situación de connotación sexual.
  - `false` solo si las 3 son claramente neutras: ropa normal (aunque sea ajustada o con algo de escote que no es el foco), pose de pie, de acción o casual, sin énfasis en el cuerpo.
  - **Ante la duda, `true`.** Clasificar como "No" algo sugerente es "clasificar mal la edad", y Pixiv lo castiga.
- `idea`: en español, una línea con el gancho y por qué encaja.
- `alerta`: `null` casi siempre. Solo frena la pieza si **alguna imagen podría parecer de una persona menor de edad**, si hay **desnudez explícita** (pezones o genitales a la vista), si es **fotorrealista** (Pixiv lo prohíbe), si **no son las 3 del mismo personaje** o si hay **animales reales** en la imagen: de fondo, como decorado o interactuando con la personaje, aunque sean chicos. No cuentan los rasgos animales que son parte del personaje (orejas y colas de Ahri, orejas de conejo de Aurora, cascos de Soraka) ni criaturas que son parte de la skin (tentáculos de Nami). En esos casos escribí el motivo en español y dejá `titulo` y `descripcion` vacíos.

No cambies `n`, `imagenes` ni ningún otro campo. No toques ningún otro archivo.

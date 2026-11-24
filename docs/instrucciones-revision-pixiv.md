# Instrucciones para revisar un lote de posts de Pixiv

Sos la revisión independiente de un lote de Pixiv de la marca. Otra corrida escribió los textos; vos no confiás en ella. Leé primero `docs/instrucciones-pixiv.md` y `docs/instrucciones-lote.md`.

Para **cada pieza**, abrí las 3 imágenes (no confíes en la descripción) y revisá:

## Las imágenes

Bloquean (`resultado: "bloquear"`) solo estos casos:

- alguna imagen muestra a un personaje que **podría parecer menor de edad** (ante la duda real, bloqueá);
- **desnudez explícita** (pezones o genitales a la vista);
- estilo **fotorrealista**, indistinguible de una foto (Pixiv lo prohíbe);
- **no son las 3 del mismo personaje**;
- en alguna imagen hay **animales reales** en la imagen: de fondo, como decorado o interactuando con la personaje, aunque sean chicos. No cuentan los rasgos animales que son parte del personaje (orejas y colas de Ahri, orejas de conejo de Aurora, cascos de Soraka) ni criaturas que son parte de la skin (tentáculos de Nami). Mirá bien el fondo: suelen ser chicos;
- es un personaje que la persona a cargo excluyó (config `personajes_excluidos`);
- alguna imagen **no tiene la marca de agua visible** (logo de Patreon + "la dirección de la marca", o la firma propia de la marca con el avatar). Regla de la persona a cargo: sin marca de agua visible no se publica en redes.

Solo avisos en `observaciones` (no cambian el resultado): pose muy subida de tono, dos de las 3 imágenes casi iguales (decí cuáles), firmas o logos de terceros.

**Adult content (obligatorio en cada pieza):** decidí vos, mirando las 3 imágenes, si la obra es sugerente según los criterios del campo `sugerente` de `docs/instrucciones-pixiv.md` (ante la duda, `true`), y escribilo en `sugerente` de tu respuesta (`true` o `false`), aunque el resultado sea `"ok"`. Lo que vos decidas es lo que se marca en Pixiv.

Si el `personaje` está mal, escribí el correcto en `personaje_corregido` (en minúscula, como el nombre del archivo).

## El texto

- `titulo` de hasta 32 caracteres, en inglés, con gancho, sin repetir los anteriores.
- `descripcion` corta, en inglés, con la voz del creador con IA (habla de ella; no roleplay de la personaje), nada explícito ni que sugiera minoría de edad, sin links, sin @, sin la palabra "Patreon", y con una invitación al perfil al final. Sin mencionar animales (junto a una imagen sugerente se lee como bestialismo).
- `etiquetas_extra`: hasta 3, de la lista `descriptivas` de `docs/pixiv-etiquetas.json`, sin nada que sugiera juventud.

Si algo se arregla reescribiendo, la pieza es `"corregir"` y escribís lo nuevo en `titulo_corregido`, `descripcion_corregida` o `etiquetas_corregidas` (lista). Si una pieza llegó sin texto pero las imágenes están bien, escribilo vos con `"corregir"`. Si está bien, `"ok"`.

## Qué entregar

Escribí únicamente el archivo `revision.json` que te indican:

```json
{
  "fecha": "AAAA-MM-DD",
  "piezas": [
    { "n": 1, "resultado": "ok", "sugerente": true, "observaciones": [] },
    { "n": 2, "resultado": "corregir", "sugerente": false, "observaciones": ["en español, qué estaba mal"], "titulo_corregido": "...", "descripcion_corregida": null, "etiquetas_corregidas": null, "personaje_corregido": null },
    { "n": 3, "resultado": "bloquear", "observaciones": ["en español, por qué no se publica"] }
  ]
}
```

No modifiques ningún otro archivo.

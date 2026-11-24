// Traductor con la voz de la marca: la persona a cargo pega un texto en cualquier idioma y la IA lo
// devuelve en inglés con el tono de los posts o de las respuestas de X. NO publica nada: la persona a cargo lo copia y lo usa a mano.
//   node herramientas/x-traducir.mjs <archivo-con-lo-pegado> <post|respuesta>
// Guarda las últimas 15 traducciones en config/x-traducciones.json (las muestra el panel).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { guardar, leer, RAIZ } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";

mkdirSync(join(RAIZ, "config/trabajo"), { recursive: true }); // carpeta de trabajo de la IA: sin claves
const RUTA = join(RAIZ, "config/x-traducciones.json");
const [archivo, tipoArg] = process.argv.slice(2);
const tipo = tipoArg === "respuesta" ? "respuesta" : "post";

const correrIA = (prompt) => ejecutarIA(prompt, { herramientas: "Read,Edit,Write", dirs: [join(RAIZ, "config/trabajo")] });

try {
  const original = readFileSync(archivo, "utf8").trim().slice(0, 3000);
  if (!original) throw new Error("No llegó texto.");
  const todo = existsSync(RUTA) ? leer(RUTA) : { traducciones: [] };
  const tmp = join(RAIZ, "config/trabajo/x-traducir-tanda.json");
  guardar(tmp, { tipo, original, ingles: null, alternativas: [], idioma_original: null, notas: null });

  const voz = tipo === "post"
    ? `Es para un POST propio de X. Leé ${join(RAIZ, "docs/instrucciones-lote.md")} (sobre todo "La voz", "Ejemplos de tono" y "Límites") y escribilo con esa voz: el creador que muestra lo que le salió, en primera persona, inglés natural de internet, corto, doble sentido sutil, 0 a 2 emojis.`
    : `Es una RESPUESTA a un post de otra persona en X. Leé ${join(RAIZ, "docs/instrucciones-interaccion.md")} y escribila con esa voz: fan entusiasta, corta (idealmente 2 a 15 palabras), inglés simple de internet, sin coqueteo ni doble sentido, cero autopromoción, 1 a 3 emojis. Si el texto es charla de fans de League of Legends (una skin, un main, Arcane), respondé como otro jugador.`;

  console.log(`== Traduciendo (${tipo})`);
  await correrIA([
    `la persona a cargo escribió un texto (campo "original" de ${tmp}) en español u otro idioma. Pasalo al inglés con la voz de la marca.`,
    voz,
    `Respetá lo que la persona a cargo quiere decir: la idea, el tono y la intención son suyos; no agregues ideas nuevas ni cambies el sentido. Adaptá la forma para que suene nativo y con la voz de la marca, no una traducción literal.`,
    `Si el original choca con un límite de las instrucciones (nombrar personajes o juegos en un post, algo explícito, algo que sugiera minoría de edad, pedir likes o follows, mencionar animales, prometer cosas), adaptalo para que cumpla y explicalo en "notas".`,
    `En ${tmp}, completá: "ingles" (la versión principal), "alternativas" (2 versiones distintas, misma idea, otro arranque o remate), "idioma_original" (en español, ej. "español") y "notas" (en español, una línea si cambiaste algo o hay algo a tener en cuenta; si no, null). Un post de X no puede pasar de 280 caracteres. No toques otros archivos.`,
  ].join(" "));

  const r = leer(tmp);
  rmSync(tmp, { force: true });
  if (!r.ingles) throw new Error("la IA no devolvió la traducción. Probá de nuevo.");
  todo.traducciones.unshift({ id: Date.now().toString(36), creado: new Date().toISOString(), tipo, original, ingles: r.ingles, alternativas: (r.alternativas ?? []).filter(Boolean).slice(0, 2), idioma_original: r.idioma_original ?? null, notas: r.notas ?? null });
  todo.traducciones = todo.traducciones.slice(0, 15);
  guardar(RUTA, todo);
  console.log(`LISTO: ${r.ingles}`);
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { if (archivo && /entrada-\d+\.txt$/.test(archivo)) rmSync(archivo, { force: true }); }

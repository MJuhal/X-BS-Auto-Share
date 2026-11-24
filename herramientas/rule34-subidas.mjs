// Asistente de subida a Rule34: la IA PREPARA cada post y la persona a cargo
// publica SIEMPRE a mano desde el formulario web (la API no permite subir y nunca se automatiza el formulario).
//   node herramientas/rule34-subidas.mjs --preparar "<carpeta>" "<source>"   agrega las imágenes nuevas a config/rule34/subidas.json
// Por cada imagen: la IA la mira y propone título (en inglés), etiquetas (lo que se ve + las que suben el puntaje según
// el análisis), rating (questionable sin desnudos, explicit con desnudos o sexo) y marca problemas (marca de agua, algo
// que parezca menor, anatomía rara, animales). Agenda: como máximo 2 por día y, del mismo personaje, una cada 2 días
// (las reglas borran lo repetitivo).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { guardar, leer, RAIZ, shaArchivo, sumarDias } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";

const DIR = join(RAIZ, "config/rule34");
const RUTA = join(DIR, "subidas.json");
const DIR_MINI = join(DIR, "mini");
mkdirSync(DIR_MINI, { recursive: true });
const EXT = /\.(png|jpe?g|webp)$/i;
const POR_DIA = 2;
const DIAS_MISMO_PJ = 2;

export const cargarSubidas = () => (existsSync(RUTA) ? leer(RUTA) : { posts: [] });
const hoyAR = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());

/** Fechas sugeridas para lo pendiente: máximo POR_DIA por día y el mismo personaje cada DIAS_MISMO_PJ días. */
export function agendar(todo) {
  const hoy = hoyAR();
  const ocupado = new Map(); // fecha → cantidad
  const ultimoPj = new Map(); // personaje → última fecha
  for (const p of todo.posts.filter((x) => x.estado === "subido" && x.subido)) {
    const f = p.subido.slice(0, 10);
    ocupado.set(f, (ocupado.get(f) ?? 0) + 1);
    if (!ultimoPj.has(p.personaje) || ultimoPj.get(p.personaje) < f) ultimoPj.set(p.personaje, f);
  }
  for (const p of todo.posts.filter((x) => x.estado === "pendiente").sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99) || a.creado.localeCompare(b.creado))) {
    let f = hoy;
    const u = ultimoPj.get(p.personaje);
    if (u && sumarDias(u, DIAS_MISMO_PJ) > f) f = sumarDias(u, DIAS_MISMO_PJ);
    while ((ocupado.get(f) ?? 0) >= POR_DIA) f = sumarDias(f, 1);
    p.fecha = f;
    ocupado.set(f, (ocupado.get(f) ?? 0) + 1);
    ultimoPj.set(p.personaje, f);
  }
  return todo;
}

const correrIA = (prompt) => ejecutarIA(prompt, { herramientas: "Read,Edit,Write", dirs: [DIR] });

async function preparar(carpeta, source) {
  if (!existsSync(carpeta)) throw new Error(`No existe la carpeta ${carpeta}`);
  if (!/^https:\/\/(www\.)?(patreon\.com|pixiv\.net|x\.com|twitter\.com)\/\S+$/.test(source ?? "") || /[?#]/.test(source)) throw new Error("El source tiene que ser la dirección limpia (sin ? ni #) de la página donde está la imagen: Patreon, Pixiv o X.");
  const todo = cargarSubidas();
  const ya = new Set(todo.posts.map((p) => p.sha256));
  const nuevas = [];
  for (const f of readdirSync(carpeta).filter((x) => EXT.test(x)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    let archivo = join(carpeta, f);
    const sha = shaArchivo(archivo);
    if (ya.has(sha)) { console.log(`ya estaba: ${f}`); continue; }
    // Franja clara en el borde derecho (defecto de la generación, 2026-11-19): si las últimas columnas son mucho más
    // claras que las de adentro, se recorta (8 px, sin reescalar: el artista puede recortar su propia obra).
    const brillo = (k) => +spawnSync("ffmpeg", ["-v", "error", "-i", archivo, "-vf", `crop=1:ih:iw-${k}:0,scale=1:1`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]).stdout?.[0];
    if (brillo(2) - brillo(14) > 25) {
      mkdirSync(join(DIR, "listas"), { recursive: true });
      const recorte = join(DIR, "listas", f.replace(EXT, ".png"));
      if (spawnSync("ffmpeg", ["-v", "error", "-y", "-i", archivo, "-vf", "crop=iw-8:ih:0:0", recorte]).status === 0) { console.log(`recortada la franja del borde: ${f}`); archivo = recorte; }
    }
    const id = `${Date.now().toString(36)}${nuevas.length}`;
    const mini = join(DIR_MINI, `${id}.jpg`);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", archivo, "-vf", "scale='min(900,iw)':-2", "-q:v", "3", mini]);
    const dim = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", archivo], { encoding: "utf8" }).stdout.trim();
    nuevas.push({ id, archivo, nombre: f, sha256: sha, mini: r.status === 0 ? mini : null, medidas: dim || null });
  }
  if (!nuevas.length) { console.log("No hay imágenes nuevas."); return; }
  let analisis = null;
  try { const a = leer(join(DIR, "analisis.json")); analisis = { suben: a.etiquetas_suben?.slice(0, 20).map((t) => t.etiqueta), bajan: a.etiquetas_bajan?.slice(0, 12).map((t) => t.etiqueta) }; } catch {}
  const tmp = join(DIR, "subidas-tanda.json");
  guardar(tmp, { source, analisis, titulos_previos: todo.posts.map((p) => p.titulo).filter(Boolean), imagenes: nuevas.map((n) => ({ id: n.id, imagen: n.mini ?? n.archivo, medidas: n.medidas, personaje: null, titulo: null, etiquetas: null, rating: null, orden: null, problemas: [], nota: null })) });
  console.log(`== Preparo ${nuevas.length} imagen(es)`);
  await correrIA([
    `Leé ${join(RAIZ, "docs/rule34.md")} (reglas de Rule34 para la marca). En ${tmp} hay imágenes para subir a Rule34: abrí cada una ("imagen") y mirala bien.`,
    `Completá en cada una: "personaje" (etiqueta de Rule34 del personaje, p. ej. evelynn), "titulo" (en inglés, corto, con la voz de la marca: segura y juguetona, sin doble sentido grosero, sin "my" de propiedad ni palabras despectivas; nombrá al personaje; distinto de "titulos_previos" y de los otros de la tanda),`,
    `"etiquetas" (un solo texto separado por espacios, en minúscula con guiones bajos, estilo Rule34: siempre ai_generated, la franquicia (league_of_legends), el personaje, 1girl/solo/female si aplica, y SOLO lo que se ve: pelo, ojos, piel, cuerpo, ropa, accesorios, pose, ángulo, fondo; entre 25 y 35 etiquetas; sumá las de "analisis.suben" que de verdad apliquen y evitá las de "analisis.bajan"; nunca etiquetas de opinión (sexy, beautiful, hot), nunca watermark, nunca nombres de artistas ni de personas reales, nunca etiquetas de algo prohibido; al final artist:forbidden_id0l),`,
    `"rating" ("questionable" si no hay desnudos ni sexo; "explicit" si se ven pezones o genitales o hay sexo), "orden" (1 = la que conviene subir primero: la más fuerte y distinta; ordená para que las seguidas no se parezcan),`,
    `"problemas" (lista en español de lo que impide subirla: marca de agua, firma o texto con link; cualquier rasgo que pueda parecer menor; anatomía rara (manos, dedos, partes pegadas); ropa fundida con la piel; animales reales; lado menor de 500 px; o "no es porno" si está demasiado tapada para Rule34) y "nota" (en español, una línea: qué revisar o por qué conviene). No inventes. No toques otros archivos.`,
  ].join(" "));
  const r = leer(tmp);
  rmSync(tmp, { force: true });
  const ahora = new Date().toISOString();
  for (const n of nuevas) {
    const x = (r.imagenes ?? []).find((y) => y.id === n.id) ?? {};
    const etiquetas = String(x.etiquetas ?? "").toLowerCase().split(/\s+/).filter((t) => t && !/^(watermark|sexy\w*|beautiful|hot|pretty)$/.test(t));
    if (!etiquetas.includes("ai_generated")) etiquetas.unshift("ai_generated");
    todo.posts.push({ id: n.id, archivo: n.archivo, nombre: n.nombre, sha256: n.sha256, mini: n.mini, medidas: n.medidas, source, personaje: x.personaje ?? null, titulo: x.titulo ?? null, etiquetas: [...new Set(etiquetas)].join(" "), rating: x.rating === "explicit" ? "explicit" : "questionable", orden: x.orden ?? null, problemas: x.problemas ?? [], nota: x.nota ?? null, estado: (x.problemas ?? []).length ? "revisar" : "pendiente", creado: ahora });
  }
  guardar(RUTA, agendar(todo));
  console.log(`LISTO: ${nuevas.length} imagen(es) preparadas; ${nuevas.filter((n) => todo.posts.find((p) => p.id === n.id)?.estado === "revisar").length} para revisar.`);
}

if (process.argv[1]?.endsWith("rule34-subidas.mjs")) {
  try {
    const [modo, a1, a2] = process.argv.slice(2);
    if (modo === "--preparar") await preparar(a1, a2);
    else console.log('Uso: --preparar "<carpeta>" "<source>"');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

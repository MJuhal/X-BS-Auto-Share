// Asistente de Reddit para la cuenta de marca la cuenta de marca.
// La IA NO publica, NO comenta, NO vota, NO sigue ni manda mensajes: la persona a cargo lo hace siempre a mano.
// Reddit bloquea la lectura automática (403) y no se esquiva: los subreddits se buscan con un buscador web común y las
// reglas las pega la persona a cargo desde su navegador.
//   node herramientas/reddit.mjs --buscar <archivo-con-el-tema>          candidatos de subreddits para ese tema
//   node herramientas/reddit.mjs --reglas <sub> <archivo-con-las-reglas> clasifica las reglas que pegó la persona a cargo
//   node herramientas/reddit.mjs --preparar <sub>                         arma un post (imagen + título) para ese sub
//   node herramientas/reddit.mjs --comentario <archivo-con-el-post>       propone comentarios para ese post
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { carpetas, cfg, guardar, leer, lotes, marcarImagen, personajeDe, publicables, RAIZ, sha256, shaArchivo } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";
import { confPixiv, ETIQUETAS, lotesPixiv, personajesPatreon, publicablesPixiv } from "./pixiv-comun.mjs";

export const DIR_REDDIT = join(RAIZ, "config/reddit");
const RUTA_SUBS = join(DIR_REDDIT, "subreddits.json");
const RUTA_POSTS = join(DIR_REDDIT, "posts.json");
const RUTA_COMS = join(DIR_REDDIT, "comentarios.json");
const DIR_IMGS = join(DIR_REDDIT, "imagenes");
mkdirSync(DIR_IMGS, { recursive: true });
const cargar = (r, def) => (existsSync(r) ? leer(r) : def);
const normal = (s) => String(s ?? "").trim().replace(/^\/?r\//i, "").replace(/[^\w]/g, "");
const VOZ = join(RAIZ, "docs/instrucciones-reddit.md");

function correrIA(prompt, herramientas) {
  return ejecutarIA(prompt, { herramientas: herramientas, dirs: [DIR_REDDIT] });
}
/** ¿Sirve para nosotros? Acepta IA y fanart (o no lo prohíbe) y no está descartado. */
const sirve = (s) => s.acepta_ia !== "no" && s.acepta_fanart !== "no";

async function buscar(archivoTema) {
  const tema = readFileSync(archivoTema, "utf8").trim().slice(0, 300);
  const subs = cargar(RUTA_SUBS, { subreddits: [] });
  const tmp = join(DIR_REDDIT, "busqueda.json");
  guardar(tmp, { tema, conocidos: subs.subreddits.map((s) => s.nombre), candidatos: [] });
  console.log(`== Busco subreddits: ${tema}`);
  const codigo = await correrIA([
    `Leé ${VOZ} (contexto de la marca y reglas). Buscá con WebSearch subreddits de Reddit para este tema: "${tema}".`,
    `La marca publica ilustraciones de anime hechas con IA, de personajes de videojuegos (sobre todo League of Legends), sugerentes pero sin desnudos, y quiere llevar gente a su perfil.`,
    `No intentes abrir páginas de reddit.com (Reddit bloquea la lectura automática y no se esquiva): trabajá solo con los resultados del buscador.`,
    `Completá "candidatos" en ${tmp} con hasta 10 subreddits activos que no estén en "conocidos", cada uno así:`,
    `{"nombre": sin "r/", "descripcion": en español una línea, "miembros": número aproximado o null, "acepta_ia": "si"|"no"|"no_dice", "acepta_fanart": "si"|"no"|"no_dice", "nsfw": "si"|"no"|"mixto"|"no_dice", "permite_links": "si"|"no"|"no_dice", "requisitos": karma o antigüedad mínimos si se sabe, o null, "notas": en español, qué conviene saber, "fuentes": [urls]}.`,
    `No inventes: lo que no sepas va "no_dice" o null. Priorizá los que aceptan arte con IA. No toques otros archivos.`,
  ].join(" "), "WebSearch,Read,Edit,Write");
  const r = cargar(tmp, { candidatos: [] });
  let nuevos = 0;
  for (const c of r.candidatos ?? []) {
    const nombre = normal(c.nombre);
    if (!nombre || subs.subreddits.some((s) => s.nombre.toLowerCase() === nombre.toLowerCase())) continue;
    subs.subreddits.push({ ...c, nombre, tema, verificado: false, estado: "candidato", agregado: new Date().toISOString() });
    nuevos++;
  }
  guardar(RUTA_SUBS, subs);
  rmSync(tmp, { force: true });
  console.log(codigo === 0 ? `LISTO: ${nuevos} subreddit(s) nuevo(s).` : `La búsqueda terminó con código ${codigo}`);
}

async function reglas(sub, archivo) {
  const subs = cargar(RUTA_SUBS, { subreddits: [] });
  const nombre = normal(sub);
  let s = subs.subreddits.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase());
  if (!s) { s = { nombre, estado: "candidato", agregado: new Date().toISOString() }; subs.subreddits.push(s); }
  const texto = readFileSync(archivo, "utf8").slice(0, 15000);
  const tmp = join(DIR_REDDIT, "reglas.json");
  guardar(tmp, { nombre, reglas: texto, acepta_ia: null, acepta_fanart: null, nsfw: null, permite_links: null, requisitos: null, flair: null, formato_titulo: null, notas: null });
  console.log(`== Clasifico las reglas de r/${nombre}`);
  const codigo = await correrIA([
    `En ${tmp} están las reglas del subreddit r/${nombre}, pegadas por la persona a cargo desde su navegador (campo "reglas").`,
    `Leyéndolas (no inventes; lo que no digan va "no_dice" o null), completá: "acepta_ia" ("si"|"no"|"no_dice": si se puede publicar arte hecho con IA), "acepta_fanart" (fanart de personajes de videojuegos), "nsfw" ("si"|"no"|"mixto"|"no_dice"), "permite_links" (links o autopromoción, p. ej. a Patreon, en el post, en comentarios o nunca), "requisitos" (karma, antigüedad, verificación), "flair" (si hay flair obligatorio, cuál conviene), "formato_titulo" (si exigen un formato, p. ej. "[OC]" o "Personaje (Juego)"), "notas" (en español, lo más importante para no romper reglas: frecuencia de posts, marca de agua, crédito, etc.).`,
    `Borrá el campo "reglas" al terminar. No toques otros archivos.`,
  ].join(" "), "Read,Edit,Write");
  const r = cargar(tmp, {});
  for (const k of ["acepta_ia", "acepta_fanart", "nsfw", "permite_links", "requisitos", "flair", "formato_titulo", "notas"]) if (r[k] !== undefined) s[k] = r[k];
  s.verificado = true;
  s.revisado = new Date().toISOString();
  if (s.estado === "candidato") s.estado = sirve(s) ? "sirve" : "no_sirve";
  guardar(RUTA_SUBS, subs);
  rmSync(tmp, { force: true });
  console.log(codigo === 0 ? `LISTO: r/${nombre} ${sirve(s) ? "sirve" : "no sirve"}.` : `La clasificación terminó con código ${codigo}`);
}

/** Imágenes disponibles: las ya preparadas (con marca de agua) de los lotes de X y de Pixiv, no usadas en Reddit. */
function imagenesDisponibles() {
  const usadas = new Set(cargar(RUTA_POSTS, { posts: [] }).posts.map((p) => p.sha256));
  const out = [];
  for (const d of lotes()) {
    for (const p of publicables(leer(join(d, "lote.json")))) {
      const f = join(d, `p${String(p.n).padStart(2, "0")}`, "imagen.jpg");
      if (existsSync(f)) out.push({ archivo: f, personaje: personajeDe(p) ?? "original" });
    }
  }
  for (const d of lotesPixiv()) {
    for (const p of publicablesPixiv(leer(join(d, "lote.json")))) for (const i of p.imagenes ?? []) {
      const f = join(d, i.archivo);
      if (existsSync(f)) out.push({ archivo: f, personaje: (p.personaje ?? "original").toLowerCase() });
    }
  }
  const vistos = new Set();
  return out.filter((x) => { const h = sha256(x.archivo); if (usadas.has(h) || vistos.has(h)) return false; vistos.add(h); x.sha256 = h; return true; });
}

/** Imágenes para los subs NSFW: el Backlog de siempre (SFW, con marca de agua), el Pack Bronze y,
 *  solo si a ese personaje no le queda otra cosa, el Pack Gold. El Pack Diamond es solo para Patreon: nunca se mira.
 *  Una carpeta por personaje con packs adentro; las combinadas ("Noxus - Leblanc-Katarina-Bronze") nombran al personaje
 *  en el archivo ("katarina-nfw-bronze-1"). */
function imagenesPacks() {
  const bancos = confPixiv(cfg()).bancos; // 2026-11-23: Personajes LOL y Packs en conjunto
  const conocidos = new Set(Object.keys(ETIQUETAS.personajes));
  const alias = { arhi: "ahri" };
  const out = [];
  for (const [banco, carpeta] of bancos.filter((b) => existsSync(b)).flatMap((b) => readdirSync(b).map((x) => [b, x]))) {
    if (/^(publicaciones|sfw)$/i.test(carpeta)) continue; // el Backlog se suma abajo
    const dir = join(banco, carpeta);
    if (!statSync(dir).isDirectory()) continue;
    const pjCarpeta = (alias[carpeta.toLowerCase()] ?? carpeta.toLowerCase());
    for (const pack of readdirSync(dir)) {
      const dp = join(dir, pack);
      if (!statSync(dp).isDirectory() || /diamond/i.test(pack) || !/^pack/i.test(pack)) continue; // Diamond: solo Patreon; solo carpetas "Pack…"
      for (const a of readdirSync(dp).filter((x) => /\.(png|jpe?g|webp)$/i.test(x))) {
        const pref = a.toLowerCase().split("-")[0];
        const pj = conocidos.has(alias[pref] ?? pref) ? (alias[pref] ?? pref) : conocidos.has(pjCarpeta) ? pjCarpeta : null;
        if (pj) out.push({ archivo: join(dp, a), personaje: pj, pack: `${carpeta}/${pack}`, gold: /gold/i.test(pack) });
      }
    }
  }
  const backlog = carpetas(cfg()).backlog;
  if (existsSync(backlog)) for (const a of readdirSync(backlog).filter((x) => /\.(png|jpe?g|webp)$/i.test(x) && !/n(s)?fw/i.test(x))) {
    const pref = a.toLowerCase().split("-")[0];
    const pj = alias[pref] ?? pref;
    if (conocidos.has(pj)) out.push({ archivo: join(backlog, a), personaje: pj, pack: "Backlog", gold: false });
  }
  return out;
}

/** Regla de la persona a cargo (2026-11-18): no repetir personaje entre posts mientras el stock lo permita; si hay que repetir,
 *  nunca uno de los 5 elegidos en los últimos 5 posts. */
function elegirPersonaje(disponibles, posts) {
  const historial = posts.filter((p) => p.estado !== "descartado").sort((x, y) => x.creado.localeCompare(y.creado)).map((p) => p.personaje);
  const conStock = [...new Set(disponibles.map((x) => x.personaje))];
  // Dentro de la regla, manda Patreon: primero los personajes con pack.
  const pat = personajesPatreon(cfg());
  const primeroPatreon = (l) => (l.some((pj) => pat.has(pj)) ? l.filter((pj) => pat.has(pj)) : l);
  const nunca = primeroPatreon(conStock.filter((pj) => !historial.includes(pj)));
  if (nunca.length) return nunca[Math.floor(Math.random() * nunca.length)];
  const ultimos5 = new Set(historial.slice(-5));
  const fuera = primeroPatreon(conStock.filter((pj) => !ultimos5.has(pj)));
  const pool = fuera.length ? fuera : conStock; // si ni así alcanza, el que hace más que no sale
  return pool.sort((x, y) => historial.lastIndexOf(x) - historial.lastIndexOf(y))[0];
}

async function preparar(sub) {
  const subs = cargar(RUTA_SUBS, { subreddits: [] });
  const s = subs.subreddits.find((x) => x.nombre.toLowerCase() === normal(sub).toLowerCase());
  if (!s) throw new Error(`No conozco r/${sub}: buscalo o pegá sus reglas primero.`);
  const posts = cargar(RUTA_POSTS, { posts: [] });
  // Cuentas nuevas: empezar con comentarios y pocos posts (Reddit castiga la promoción temprana).
  const pl = subs.plan ?? {};
  if (pl.pausa) throw new Error(`Reddit está en pausa: ${pl.pausa.motivo}`);
  const rc = pl.reglas_cuenta_nueva;
  if (rc && pl.inicio) {
    const hoy = new Date().toISOString().slice(0, 10);
    const desde = new Date(Date.parse(`${pl.inicio}T12:00:00Z`) + rc.solo_comentarios_dias * 86400e3).toISOString().slice(0, 10);
    if (hoy < desde) throw new Error(`Cuenta nueva: hasta el ${desde} solo comentarios, sin posts.`);
    const recientes = posts.posts.filter((p) => ["preparado", "publicado"].includes(p.estado) && Date.now() - Date.parse(p.publicado ?? p.creado) < 24 * 3600e3);
    if (recientes.length >= rc.max_posts_dia) throw new Error(`Ya hay ${recientes.length} post(s) de Reddit en las últimas 24 horas (máximo ${rc.max_posts_dia} por día con la cuenta nueva).`);
  }
  // Subs NSFW: imágenes de los packs. SFW: las ya preparadas de los lotes (Backlog, con marca de agua).
  const nsfw = s.segmento === "nsfw";
  // Una imagen usada no se repite en ningún sub; una rechazada por la revisión, solo en ese sub (puede servir en otro).
  const cuenta = posts.posts.filter((p) => p.estado !== "descartado" || p.subreddit === s.nombre);
  const usadasRuta = new Set(cuenta.map((p) => p.origen).filter(Boolean));
  const usadasSha = new Set(cuenta.map((p) => p.sha256));
  let disp = (nsfw ? imagenesPacks() : imagenesDisponibles()).filter((x) => !usadasRuta.has(x.archivo));
  let elegida = null;
  while (disp.length && !elegida) {
    const pj = elegirPersonaje(disp, posts.posts);
    const todasPj = disp.filter((x) => x.personaje === pj);
    const delPj = todasPj.some((x) => !x.gold) ? todasPj.filter((x) => !x.gold) : todasPj; // Gold, solo si no queda otra
    const c = delPj[Math.floor(Math.random() * delPj.length)];
    c.sha256 = c.sha256 ?? shaArchivo(c.archivo);
    if (usadasSha.has(c.sha256)) { disp = disp.filter((x) => x !== c); continue; } // misma imagen con otro nombre
    elegida = c;
  }
  if (!elegida) throw new Error("No quedan imágenes sin usar en Reddit.");
  const id = `${Date.now().toString(36)}`;
  const img = join(DIR_IMGS, `${id}.jpg`);
  // JPG sin metadatos (los PNG de ComfyUI guardan el flujo y los prompts) y con la marca de agua (regla: sin marca
  // visible no se publica en redes gratis).
  const r0 = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", elegida.archivo, "-vf", "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease", "-map_metadata", "-1", "-q:v", "2", "-frames:v", "1", img]);
  if (r0.status !== 0 || !existsSync(img)) throw new Error(`No pude preparar ${basename(elegida.archivo)}.`);
  if (nsfw) marcarImagen(img, elegida.archivo, cfg());
  const titulosPrevios = posts.posts.map((p) => p.titulo).filter(Boolean).slice(-40);
  const tmp = join(DIR_REDDIT, "post.json");
  const plan = subs.plan ?? {};
  const calentamiento = !!plan.links_desde && new Date().toISOString().slice(0, 10) < plan.links_desde;
  guardar(tmp, { subreddit: s, calentamiento, links_desde: plan.links_desde ?? null, modelo_base: plan.modelo_base ?? null, creador: "la marca", imagen: img, personaje: elegida.personaje, titulos_previos: titulosPrevios, titulo: null, flair: null, nsfw: null, comentario_inicial: null, notas: null });
  console.log(`== Preparo un post para r/${s.nombre} (${elegida.personaje}, ${elegida.pack ?? "lote"})`);
  const codigo = await correrIA([
    `Leé ${VOZ} y seguilo. En ${tmp} está el subreddit (con sus reglas clasificadas) y la imagen a publicar (campo "imagen": abrila y mirala).`,
    `Completá: "titulo" (en inglés, con la voz de la marca para Reddit y el formato que exija el sub, usando "creador" si el formato lo pide; si el formato es "NombreDeLaObra - (creador)", el nombre de la obra es un título corto y con onda que nombra al personaje, p. ej. "Ahri after the festival - (la marca)", nunca solo el nombre del juego; sin links ni la palabra Patreon; distinto de "titulos_previos"), "flair" (el que corresponda según el sub; si pide el modelo base, usá "modelo_base"), "nsfw" (true si la imagen tiene desnudez o contenido sexual, o si el sub lo requiere), "comentario_inicial" (solo si el sub permite links o crédito en un comentario: un comentario corto de la persona a cargo con la invitación al perfil; si no, null), "notas" (en español: qué revisar antes de publicar).`,
    `Si "calentamiento" es true, la cuenta todavía está juntando karma: "comentario_inicial" va en null (sin links ni invitación al perfil hasta "links_desde"). Si es false, seguí "frecuencia_link" del subreddit.`,
    `El subreddit ${nsfw ? "es NSFW: la desnudez y el contenido sexual están permitidos según sus reglas" : "es SFW: si la imagen tiene desnudez o es demasiado sugerente para sus reglas, no sirve"}. Si en la imagen aparece cualquier animal, aunque sea chico o de fondo (cabra, perro, gato, criatura, mascota), no sirve para Reddit: en contenido sugerente o adulto se puede leer como bestialismo. Si la imagen podría parecer de alguien menor de edad (por la cara, el cuerpo o el contexto, p. ej. escolar), si tiene un animal, o rompe una regla del sub, poné "titulo": null y explicá en "notas". No toques otros archivos.`,
  ].join(" "), "Read,Edit,Write");
  const r = cargar(tmp, {});
  rmSync(tmp, { force: true });
  if (!r.titulo) {
    rmSync(img, { force: true });
    // la imagen queda registrada como descartada para no volver a elegirla
    posts.posts.push({ id, subreddit: s.nombre, personaje: elegida.personaje, origen: elegida.archivo, sha256: elegida.sha256, estado: "descartado", motivo: r.notas ?? "sin título", creado: new Date().toISOString() });
    guardar(RUTA_POSTS, posts);
    throw new Error(`No se armó el post: ${r.notas ?? "sin título"}`);
  }
  const notas = [elegida.gold ? "Pack Gold: revisalo antes de publicar." : null, r.notas].filter(Boolean).join(" ") || null;
  posts.posts.push({ id, subreddit: s.nombre, personaje: elegida.personaje, imagen: img, origen: elegida.archivo, pack: elegida.pack ?? null, sha256: elegida.sha256, titulo: r.titulo, flair: r.flair ?? null, nsfw: !!r.nsfw, comentario_inicial: r.comentario_inicial ?? null, notas, estado: "preparado", creado: new Date().toISOString() });
  guardar(RUTA_POSTS, posts);
  console.log(codigo === 0 ? `LISTO: post para r/${s.nombre}.` : `La redacción terminó con código ${codigo}`);
}

async function comentario(archivo) {
  const entrada = readFileSync(archivo, "utf8").slice(0, 4000);
  const coms = cargar(RUTA_COMS, { comentarios: [] });
  const tmp = join(DIR_REDDIT, "comentario.json");
  guardar(tmp, { post: entrada, previos: coms.comentarios.flatMap((c) => c.opciones ?? []).slice(-30), opciones: [] });
  console.log("== Comentario sugerido");
  const codigo = await correrIA([
    `Leé ${VOZ} y seguilo (sección de comentarios). En ${tmp} está un post de Reddit que pegó la persona a cargo (campo "post": subreddit, título y, si hay, texto o descripción de la imagen).`,
    `Completá "opciones" con 3 comentarios distintos para que la persona a cargo elija uno, en inglés, distintos de "previos". No toques otros archivos.`,
  ].join(" "), "Read,Edit,Write");
  const r = cargar(tmp, { opciones: [] });
  rmSync(tmp, { force: true });
  coms.comentarios.unshift({ id: Date.now().toString(36), post: entrada, opciones: (r.opciones ?? []).filter((o) => !/https?:|www\.|patreon|@\w/i.test(o)), creado: new Date().toISOString() });
  coms.comentarios = coms.comentarios.slice(0, 20);
  guardar(RUTA_COMS, coms);
  console.log(codigo === 0 ? "LISTO" : `La redacción terminó con código ${codigo}`);
}

const [modo, a1, a2] = process.argv.slice(2);
try {
  if (modo === "--buscar") await buscar(a1);
  else if (modo === "--reglas") await reglas(a1, a2);
  else if (modo === "--preparar") {
    // Si la revisión rechaza la imagen, se prueba con otra (queda registrada y no se vuelve a elegir): hasta 3 intentos.
    for (let i = 1; ; i++) {
      try { await preparar(a1); break; } catch (e) {
        if (!/^No se armó el post/.test(e.message) || i >= 3) throw e;
        console.log(`${e.message.slice(0, 160)}… Pruebo con otra imagen (intento ${i + 1} de 3).`);
      }
    }
  }
  else if (modo === "--comentario") await comentario(a1);
  else console.log("Uso: --buscar <archivo> | --reglas <sub> <archivo> | --preparar <sub> | --comentario <archivo>");
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { for (const f of [a1, a2]) if (f && /entrada-\d+\.txt$/.test(f)) rmSync(f, { force: true }); } // lo que mandó el panel, ya usado

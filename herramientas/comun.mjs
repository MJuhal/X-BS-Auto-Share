// Funciones compartidas: configuración, rutas, lote, control de textos, huella y datos locales.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const RAIZ = join(import.meta.dirname, "..");
export const CONFIG = process.env.X_CONFIG || join(RAIZ, "config/x.json");
export const leer = (f) => JSON.parse(readFileSync(f, "utf8"));
export const guardar = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
export const CLAVES_RUTA = process.env.X_CLAVES || join(RAIZ, "config/claves.json");
const BASE = join(RAIZ, "docs/config.base.json");
/** ¿Ya se completó el asistente de primer inicio? */
export const configurado = () => { try { return leer(CONFIG).configurado === true; } catch { return false; } };
/** Configuración. Sin config/x.json usa la base (vacía), así el panel puede arrancar y mostrar el asistente. */
export function cfg() {
  const c = existsSync(CONFIG) ? leer(CONFIG) : leer(BASE);
  c.publicacion.publicador = CLAVES_RUTA; // las claves viven siempre acá (fuera de git)
  return c;
}
export const leerClaves = () => (existsSync(CLAVES_RUTA) ? leer(CLAVES_RUTA) : {});
/** Chrome instalado (Pixiv y marca de agua), o null. */
export const chrome = () => [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")].find((x) => x && existsSync(x)) ?? null;
/** ¿El texto nombra a la marca? (los comentarios sugeridos nunca hacen autopromoción) */
export const nombraMarca = (t, c = cfg()) => [c.marca?.nombre, c.marca?.x, c.marca?.bluesky?.split("/").pop()].map((x) => String(x ?? "").replace(/^@/, "").trim().toLowerCase()).filter((x) => x.length > 3).some((x) => String(t ?? "").toLowerCase().includes(x));

/** Carpetas de contenido (fuera del repo). la persona a cargo deja las imágenes en la carpeta de entrada
 *  (config "publicaciones"; si falta, <contenido>/nuevas): Lote… (lotes de 10, prioridad) y Backlog
 *  (reserva que se pre-aprueba y rellena los días sin post). Los lotes armados van a la carpeta de lotes (config "lotes"; si falta, <contenido>/lotes),
 *  una subcarpeta por fecha. En <contenido> quedan solo archivos internos (rechazadas.json, candado). */
export function carpetas(c = cfg()) {
  const base = c.contenido || join(RAIZ, "config/sin-configurar");
  const nuevas = c.publicaciones || join(base, "nuevas");
  // Sin configurar: carpetas dentro de config/ que no existen (nada que mostrar).
  return { base, nuevas, backlog: join(nuevas, "Backlog"), lotes: c.lotes || join(base, "lotes") };
}

/** Carpetas "Lote…" dentro de la carpeta de entrada que tienen imágenes, de la más vieja a la más nueva. */
export function carpetasLote(c = cfg()) {
  const { nuevas, lotes: armados } = carpetas(c);
  if (!existsSync(nuevas)) return [];
  const mismo = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
  return readdirSync(nuevas)
    .filter((d) => /^lote/i.test(d) && statSync(join(nuevas, d)).isDirectory())
    .map((d) => join(nuevas, d))
    .filter((d) => !mismo(d, armados)) // la carpeta de lotes armados ("Lotes") no es un Lote nuevo
    .filter((d) => pendientes(d, c).length)
    .sort((a, b) => statSync(a).birthtimeMs - statSync(b).birthtimeMs);
}

/** Archivos que nunca pueden ir a X: los marcados como no aptos ("nfw" o "nsfw") en el nombre. */
export const prohibidaPorNombre = (ruta) => /(^|[^a-z])ns?fw([^a-z]|$)/i.test(ruta.split(/[\\/]/).pop());

/** Personajes que la persona a cargo ya no quiere publicar en X, Bluesky ni Pixiv (config "personajes_excluidos"). El personaje sale del nombre del archivo ("evelynn-sfw-cute-3"). */
export const personajeExcluido = (ruta, c = cfg()) =>
  (c.personajes_excluidos ?? []).map((x) => x.toLowerCase()).includes(ruta.split(/[\\/]/).pop().toLowerCase().split("-")[0]);

/** SHA-256 de un archivo con caché por ruta, tamaño y fecha (el panel lo consulta seguido). */
const cacheSha = new Map();
export function shaArchivo(ruta) {
  const s = statSync(ruta);
  const k = `${ruta}|${s.size}|${s.mtimeMs}`;
  if (!cacheSha.has(k)) cacheSha.set(k, sha256(ruta));
  return cacheSha.get(k);
}

/** Las imágenes de la carpeta de entrada no se mueven (es el banco de la persona a cargo): se copian al lote.
 *  Una imagen ya usada se reconoce por su contenido (SHA-256 del original), aunque la renombren. */
export function usadas(c = cfg()) {
  const set = new Set();
  for (const d of lotes(c)) for (const p of leer(join(d, "lote.json")).piezas) if (p.sha256_original) set.add(p.sha256_original);
  const rech = join(carpetas(c).base, "rechazadas.json");
  if (existsSync(rech)) for (const r of leer(rech)) set.add(r.sha256);
  return set;
}

/** Imágenes de una carpeta de entrada que todavía no se usaron y que pueden ir a X. */
export function pendientes(dir, c = cfg(), ya = usadas(c)) {
  return imagenes(dir).filter((f) => !prohibidaPorNombre(f) && !personajeExcluido(f, c) && !ya.has(shaArchivo(f)));
}

export const pNN = (n) => `p${String(n).padStart(2, "0")}`;
export const idPieza = (lote, n) => `${lote}-${pNN(n)}`;
export const sha256 = (ruta) => createHash("sha256").update(readFileSync(ruta)).digest("hex");
export const EXT_IMAGEN = /\.(jpe?g|png|webp)$/i;

/** Imágenes de una carpeta en orden natural de nombre (01, 02, ... 10). */
export function imagenes(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => EXT_IMAGEN.test(f) && statSync(join(dir, f)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((f) => join(dir, f));
}

/** Lotes existentes (carpetas con lote.json), del más viejo al más nuevo. */
export function lotes(c = cfg()) {
  const { lotes: dir } = carpetas(c);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, "lote.json"))).sort().map((d) => join(dir, d));
}

export const estadoDe = (dir) => (existsSync(join(dir, "estado.json")) ? leer(join(dir, "estado.json")) : { piezas: {} });

/** Peso de un texto según X: URLs = 23, la mayoría de los caracteres latinos = 1, emojis y CJK = 2. Límite 280. */
export function pesoX(texto) {
  const sinUrls = texto.replace(/https?:\/\/\S+/g, () => "\u0000".repeat(23));
  let peso = 0;
  for (const ch of sinUrls) {
    const cp = ch.codePointAt(0);
    const liviano = cp === 0 || cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
    peso += liviano ? 1 : 2;
  }
  return peso;
}

/** Largo de un texto para Bluesky: grafemas (un emoji cuenta 1, los links cuentan entero). Máximo 300. */
const SEG = new Intl.Segmenter("en", { granularity: "grapheme" });
export const pesoBsky = (texto) => [...SEG.segment(texto)].length;

/** Redes donde se publica. Se piensa todo para X y se replica igual (texto, imagen, días) en Bluesky.
 *  clave = dónde guarda el estado cada pieza en estado.json (piezas[n].x / piezas[n].bsky). */
export function redes(c = cfg()) {
  const pub = c.publicacion;
  const out = [];
  if (pub.canal?.buffer_id) out.push({ clave: "x", nombre: "X", canal: pub.canal, limite: 280, peso: pesoX, desfase_min: 0, desde: null });
  const b = pub.bluesky;
  if (b?.activa && b.canal?.buffer_id) out.push({ clave: "bsky", nombre: "Bluesky", canal: b.canal, limite: 300, peso: pesoBsky, desfase_min: b.desfase_min ?? 0, desde: b.desde ?? null });
  return out;
}

const PROHIBIDAS = leer(join(RAIZ, "docs/palabras-prohibidas.json"));
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Texto final que se publica (reemplaza {PATREON} por el link). */
export function textoFinal(texto, c = cfg()) {
  return texto.replace(/\{PATREON\}/g, c.marca.patreon).trim();
}

/** Hashtag del personaje: "Miss Fortune" → "#MissFortune",
 *  "Kai'Sa" → "#KaiSa". Sin personaje u "original": null. Lo agrega el sistema; la redacción nunca nombra al personaje. */
export function hashtagPersonaje(personaje) {
  const v = String(personaje ?? "").trim();
  if (!v || v.toLowerCase() === "original") return null;
  const limpio = v.normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return limpio ? `#${limpio}` : null;
}
const tagsDe = (s) => new Set((s.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((x) => x.toLowerCase()));

/** Texto para X: el texto con el link y, si entra en los 280 y no lo trae, el hashtag del personaje al final. */
export function textoX(texto, c = cfg(), personaje = null) {
  const base = textoFinal(texto, c);
  const tag = hashtagPersonaje(personaje);
  // En X, 2 hashtags como máximo (más le resta alcance): si el texto ya trae 2, no se agrega.
  if (!tag || tagsDe(base).has(tag.toLowerCase()) || tagsDe(base).size >= 2 || pesoX(`${base} ${tag}`) > 280) return base;
  return `${base} ${tag}`;
}

/** Texto para Bluesky: el mismo de X más, al final, el hashtag del personaje y los fijos de Bluesky (config
 *  `publicacion.bluesky.hashtags`), sin repetir los que el texto ya trae. Si no entran en los 300 caracteres, se sacan
 *  hashtags desde el final (el del personaje es el último en salir): el texto nunca se corta.
 *  hashtags de quien consume, no de creadores (#aiart, #digitalart y #anime se pierden en minutos). */
export const HASHTAGS_BSKY = ["#LeagueOfLegends", "#animegirl", "#waifu", "#AIArtwork"];
export function textoBsky(texto, c = cfg(), personaje = null) {
  const base = textoFinal(texto, c);
  const ya = tagsDe(base);
  const tags = [hashtagPersonaje(personaje), ...(c.publicacion?.bluesky?.hashtags ?? HASHTAGS_BSKY)].filter((x) => x && !ya.has(x.toLowerCase()));
  while (tags.length && pesoBsky(`${base}\n\n${tags.join(" ")}`) > 300) tags.pop();
  return tags.length ? `${base}\n\n${tags.join(" ")}` : base;
}

/** Textos de los otros lotes (normalizados: minúsculas, sin espacios repetidos ni el marcador), para no repetir nunca.
 *  Regla de la persona a cargo (2026-11-18): el contenido de un lote nunca puede ser igual al de otro. */
const normalizar = (s) => String(s ?? "").toLowerCase().replace(/\{patreon\}/g, "").replace(/\s+/g, " ").trim();
let cacheTextos = { t: 0, m: new Map() };
function textosDeOtros(c) {
  if (Date.now() - cacheTextos.t < 10e3) return cacheTextos.m;
  const m = new Map();
  for (const d of lotes(c)) { const l = leer(join(d, "lote.json")); for (const x of l.piezas) if (x.texto) { const k = normalizar(x.texto); if (!m.has(k)) m.set(k, []); m.get(k).push(`${l.lote}#${x.n}`); } }
  cacheTextos = { t: Date.now(), m };
  return m;
}

/** Control automático de un texto. Devuelve la lista de problemas (vacía = ok). `lote` = nombre del lote de la pieza. */
export function controlar(pieza, c = cfg(), { lote = null } = {}) {
  const p = [];
  const t = (pieza.texto ?? "").trim();
  if (!t) return ["sin texto"];
  if (!pieza.imagen) p.push("sin imagen (nunca se publica texto solo)");
  const repetido = (textosDeOtros(c).get(normalizar(t)) ?? []).filter((id) => id !== `${lote}#${pieza.n}`);
  if (lote && repetido.length) p.push(`texto repetido (igual a ${repetido.join(", ")})`);
  const bajo = t.toLowerCase().replace(/\{patreon\}/g, " ");
  for (const [grupo, lista] of Object.entries(PROHIBIDAS)) {
    if (grupo.startsWith("_")) continue;
    for (const w of lista) {
      if (new RegExp(`(^|[^a-z0-9])${escapar(w)}([^a-z0-9]|$)`, "i").test(bajo)) p.push(`palabra no permitida (${grupo}): "${w}"`);
    }
  }
  if (/https?:\/\/|www\./i.test(t)) p.push("tiene un link escrito a mano (el link solo va con {PATREON})");
  if (/(^|\s)@\w/.test(t)) p.push("menciona una cuenta (@)");
  const tags = t.match(/#\w+/g) ?? [];
  if (tags.length > 2) p.push(`${tags.length} hashtags (máximo 2)`);
  const tienePatreon = t.includes("{PATREON}");
  if (pieza.cta === "patreon" && !tienePatreon) p.push("el CTA es patreon y falta {PATREON}");
  if (pieza.cta !== "patreon" && tienePatreon) p.push(`el CTA es ${pieza.cta} y tiene {PATREON}`);
  const peso = pesoX(textoX(t, c, pieza.personaje));
  if (peso > 280) p.push(`${peso} caracteres para X (máximo 280)`);
  if (redes(c).some((r) => r.clave === "bsky")) { const pb = pesoBsky(textoBsky(t, c, pieza.personaje)); if (pb > 300) p.push(`${pb} caracteres para Bluesky (máximo 300)`); }
  if (!pieza.alt?.trim()) p.push("sin texto alternativo");
  else if (pieza.alt.length > 1000) p.push("texto alternativo de más de 1000 caracteres");
  return p;
}

/** Redes de un lote. Sin campo "redes" = las dos (lotes de antes).
 *  Un lote con redes ["x"] solo sale en X; con ["bsky"], solo en Bluesky (con su propia agenda). */
export const redesLote = (lote) => (Array.isArray(lote?.redes) && lote.redes.length ? lote.redes : ["x", "bsky"]);
/** Red que manda en la agenda de un lote: X si sale en X; si no, Bluesky. */
export const redAgenda = (lote) => (redesLote(lote).includes("x") ? "x" : "bsky");

/** Piezas que se publican: no bloqueadas. */
export const publicables = (lote) => lote.piezas.filter((p) => !p.bloqueada);

/** Huella del lote: lo que la persona a cargo aprueba (texto, alt, fecha, hora e imagen de cada pieza publicable).
 *  En el backlog no entran fecha ni hora: se asignan después, cuando un día queda sin post. */
export function huellaLote(dir) {
  const lote = leer(join(dir, "lote.json"));
  const backlog = lote.tipo === "backlog";
  const piezas = publicables(lote).map((p) => ({ id: idPieza(lote.lote, p.n), texto: p.texto, alt: p.alt, ...(backlog ? {} : { fecha: p.fecha, hora: p.hora, zona: p.zona }), sha256: p.sha256 }));
  // Las redes entran en la huella solo si el lote las fija (así la aprobación de los lotes de antes no cambia).
  return createHash("sha256").update(JSON.stringify(lote.redes ? { redes: lote.redes, piezas } : piezas)).digest("hex");
}

/** "AAAA-MM-DD" + "HH:MM" en una zona IANA → instante UTC. */
export function instante(fecha, hora, zona) {
  const base = Date.parse(`${fecha}T${hora}:00Z`);
  const enZona = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  };
  let ms = base - (enZona(base) - base);
  ms = base - (enZona(ms) - ms);
  return new Date(ms);
}

/** Fecha de hoy en la zona de publicación. */
export function hoyEn(zona) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Personaje normalizado de una pieza (null si no se sabe; "original" no cuenta como repetido). */
export const personajeDe = (p) => {
  const v = (p?.personaje ?? "").trim().toLowerCase();
  return v && v !== "original" ? v : null;
};

/** Agenda de publicación: franjas (horas) de cada día según el día de la semana.
 *  config publicacion.agenda: { "lun": ["20:00"], ..., "vie": ["13:00", "21:00"], ... }.
 *  Si no hay agenda, una franja por día alternando publicacion.horas (comportamiento viejo). */
const DIAS = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
export function franjasDe(fecha, c = cfg(), red = "x") {
  // Bluesky con agenda propia: publicacion.bluesky.agenda y .cambios_agenda; si no tiene, la de X.
  const b = c.publicacion.bluesky;
  const propia = red === "bsky" && (b?.agenda || b?.cambios_agenda);
  const horas = c.publicacion.horas;
  const cambios_agenda = (propia ? b.cambios_agenda : c.publicacion.cambios_agenda) ?? [];
  // Cambios con fecha de inicio:
  // publicacion.cambios_agenda: [{ "desde": "2026-11-25", "agenda": { ... } }]; manda el último que ya empezó.
  const cambio = [...cambios_agenda].sort((a, b) => a.desde.localeCompare(b.desde)).filter((x) => x.desde <= fecha).at(-1);
  const agenda = cambio?.agenda ?? (propia ? b.agenda ?? c.publicacion.agenda : c.publicacion.agenda);
  if (agenda) return [...(agenda[DIAS[new Date(`${fecha}T12:00:00Z`).getUTCDay()]] ?? [])].sort();
  return [horas[Math.round(Date.parse(`${fecha}T12:00:00Z`) / 86400e3) % horas.length]];
}
const clave = (fecha, hora) => `${fecha} ${hora}`;

/** Franjas a partir de un momento (exclusivo), en orden: [{ fecha, hora }]. */
export function franjasDesde(fecha, hora, cuantas, c = cfg(), red = "x") {
  const out = [];
  for (let d = fecha, k = 0; out.length < cuantas && k < 400; d = sumarDias(d, 1), k++)
    for (const h of franjasDe(d, c, red)) if (clave(d, h) > clave(fecha, hora) && out.length < cuantas) out.push({ fecha: d, hora: h });
  return out;
}

/** Posts de los lotes aprobados (los fallidos o vencidos no cuentan): "fecha hora" → personaje. */
export function postsPorFranja(c = cfg(), excluir = null, red = "x") {
  const m = new Map();
  for (const d of lotes(c)) {
    if (d === excluir || !aprobado(d)) continue; // las fechas de un lote sin aprobar son tentativas
    const lote = leer(join(d, "lote.json"));
    if (!redesLote(lote).includes(red)) continue; // cada red tiene su agenda (2026-11-23)
    const est = estadoDe(d).piezas;
    for (const p of publicables(lote)) if (p.fecha && !NO_SALE.includes(est[p.n]?.[red]?.estado)) m.set(clave(p.fecha, p.hora), personajeDe(p));
  }
  return m;
}

/** Personaje del post anterior y del siguiente a una franja (entre los ocupados). */
function vecinosDe(ocupados, k) {
  const orden = [...ocupados.keys()].sort();
  const antes = orden.filter((x) => x < k).at(-1);
  const despues = orden.find((x) => x > k);
  return [ocupados.get(antes), ocupados.get(despues)].filter(Boolean);
}

/** Asigna fecha y hora a las piezas publicables de un lote: una por franja de la agenda, desde la franja
 *  siguiente al último post de los otros lotes aprobados y del backlog ya usado (y nunca antes de 20 minutos
 *  desde ahora). Las bloqueadas quedan sin fecha.
 *  Regla de la persona a cargo (2026-11-17): nunca dos posts seguidos del mismo personaje. Se ordenan las piezas para
 *  alternar (empezando por uno distinto al del último post); si el lote no da para alternar, el panel avisa. */
export function asignarFechas(dir, c = cfg()) {
  const ruta = join(dir, "lote.json");
  const lote = leer(ruta);
  if (lote.tipo === "backlog") return lote; // el backlog toma fecha recién cuando rellena una franja
  const { zona } = c.publicacion;
  const red = redAgenda(lote);
  const ocupados = postsPorFranja(c, dir, red);
  // Estrategia de volumen: se llenan las franjas libres de la agenda desde ahora (no solo después
  // del último post), con al menos `separacion_min` (180) minutos respecto de cualquier otro post (sirve cuando cambia
  // la agenda y quedan posts viejos en otros horarios). Nunca antes de 20 minutos desde ahora.
  const sep = (c.publicacion.separacion_min ?? 180) * 60e3;
  const instantes = () => [...ocupados.keys()].map((k) => instante(...k.split(" "), zona).getTime());
  for (const p of lote.piezas) if (p.bloqueada) Object.assign(p, { fecha: null, hora: null, zona: null });
  const pend = lote.piezas.filter((p) => !p.bloqueada);
  const minimo = Date.now() + 20 * 60e3;
  for (let d = hoyEn(zona), k = 0; pend.length && k < 400; d = sumarDias(d, 1), k++) {
    for (const hora of franjasDe(d, c, red)) {
      if (!pend.length) break;
      const kf = clave(d, hora);
      const t = instante(d, hora, zona).getTime();
      if (ocupados.has(kf) || t < minimo || instantes().some((x) => Math.abs(x - t) < sep)) continue;
      const vecinos = vecinosDe(ocupados, kf);
      const cuenta = new Map();
      for (const p of pend) cuenta.set(personajeDe(p), (cuenta.get(personajeDe(p)) ?? 0) + 1);
      const distintos = pend.filter((p) => !personajeDe(p) || !vecinos.includes(personajeDe(p)));
      // Primero el personaje con más piezas pendientes, así no quedan varios iguales para el final.
      const p = (distintos.length ? distintos : pend).sort((a, b) => cuenta.get(personajeDe(b)) - cuenta.get(personajeDe(a)) || a.n - b.n)[0];
      pend.splice(pend.indexOf(p), 1);
      Object.assign(p, { fecha: d, hora, zona });
      ocupados.set(kf, personajeDe(p));
    }
  }
  guardar(ruta, lote);
  return lote;
}

/** Posts que repiten el personaje del post anterior, en una lista de { fecha, hora, personaje }. */
export function seguidos(posts) {
  const orden = posts.filter((x) => x.fecha && x.hora).sort((a, b) => clave(a.fecha, a.hora).localeCompare(clave(b.fecha, b.hora)));
  const out = [];
  for (let k = 1; k < orden.length; k++) if (orden[k].personaje && orden[k].personaje === orden[k - 1].personaje) out.push({ fecha: orden[k].fecha, hora: orden[k].hora });
  return out;
}

export const aprobado = (dir) => existsSync(join(dir, "aprobacion.json")) && leer(join(dir, "aprobacion.json")).huella === huellaLote(dir);
// CANCELADO: sacado de Buffer a pedido; no se vuelve a programar.
export const NO_SALE = ["VENCIDO", "FALLIDO", "BLOQUEADO", "CANCELADO"];

/** Posts aprobados que todavía no salieron ni fallaron, con fecha de hoy en adelante. */
export function porSalir(c = cfg(), red = "x") {
  const hoy = hoyEn(c.publicacion.zona);
  let n = 0;
  for (const d of lotes(c)) {
    if (!aprobado(d)) continue;
    const lote = leer(join(d, "lote.json"));
    if (!redesLote(lote).includes(red)) continue;
    const est = estadoDe(d).piezas;
    for (const p of publicables(lote)) if (p.fecha && p.fecha >= hoy && !["PUBLICADO", ...NO_SALE].includes(est[p.n]?.[red]?.estado)) n++;
  }
  return n;
}

/** Posts del backlog aprobados que todavía no tienen franja asignada (lotes viejos de tipo backlog). */
export function backlogListo(c = cfg()) {
  return lotes(c).filter((d) => leer(join(d, "lote.json")).tipo === "backlog" && aprobado(d))
    .flatMap((d) => publicables(leer(join(d, "lote.json"))).filter((p) => !p.fecha).map((p) => ({ dir: d, n: p.n, personaje: personajeDe(p) })));
}

/** Rellena con el backlog aprobado las franjas sin post de hoy (las que todavía llegan) y de mañana.
 *  Cuenta como ocupada cualquier franja con un post aprobado que no haya fallado.
 *  Elige el primer post del backlog cuyo personaje no sea el del post anterior ni el del siguiente;
 *  si no hay ninguno, esa franja queda sin post (regla: nunca dos posts seguidos del mismo personaje). */
export function rellenarConBacklog(c = cfg(), { margenMin = 20 } = {}) {
  const { zona } = c.publicacion;
  const ocupados = postsPorFranja(c);
  const hoy = hoyEn(zona);
  const hechos = [];
  for (const dia of [hoy, sumarDias(hoy, 1)]) for (const hora of franjasDe(dia, c)) {
    const k = clave(dia, hora);
    if (ocupados.has(k)) continue;
    if (instante(dia, hora, zona).getTime() < Date.now() + margenMin * 60e3) continue; // ya no llega
    const lista = backlogListo(c);
    const vecinos = vecinosDe(ocupados, k);
    const libre = lista.find((b) => !b.personaje || !vecinos.includes(b.personaje));
    if (!libre) { hechos.push({ dia, hora, falta: true, motivo: lista.length ? `el backlog solo tiene ${[...new Set(lista.map((b) => b.personaje))].join(", ")}, igual que el post de al lado` : "el backlog aprobado se terminó" }); continue; }
    const ruta = join(libre.dir, "lote.json");
    const lote = leer(ruta);
    Object.assign(lote.piezas.find((p) => p.n === libre.n), { fecha: dia, hora, zona });
    guardar(ruta, lote);
    ocupados.set(k, libre.personaje);
    hechos.push({ dia, hora, id: idPieza(lote.lote, libre.n) });
  }
  return hechos;
}

/** Marca de agua (obligatoria; versión Patreon, la persona a cargo 2026-11-18): logo de Patreon + "la dirección de la marca",
 *  blanca, chica y semitransparente, abajo a la izquierda o a la derecha según dónde moleste menos.
 *  config "marca_agua": { "imagen": PNG transparente (herramientas/marca.mjs), "ancho": fracción del ancho (0.3),
 *  "opacidad": 0.75, "ya_marcadas": [sha256 de originales que ya traen esta marca] }.
 *  También cuenta como marcado todo original anotado en <contenido>/marcadas.json.
 *  `original` es la ruta del archivo original (o null). Modifica `ruta` (JPG o PNG) en el lugar. */
export function yaMarcada(original, c = cfg()) {
  if (!original || !existsSync(original)) return false;
  const s = shaArchivo(original);
  if ((c.marca_agua?.ya_marcadas ?? []).includes(s)) return true;
  const f = join(carpetas(c).base, "marcadas.json");
  return existsSync(f) && leer(f).includes(s);
}

/** Qué esquina de abajo molesta menos: la de menos detalle (bordes) y no demasiado clara (el blanco no se leería). */
export function esquinaLibre(ruta, w, h) {
  const zw = Math.round(w * 0.4), zh = Math.round(h * 0.13);
  const puntaje = (x) => {
    const r = spawnSync("ffmpeg", ["-v", "error", "-i", ruta, "-vf", `crop=${zw}:${zh}:${x}:${h - zh},scale=64:16:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1e6 });
    const px = [...r.stdout];
    let bordes = 0, brillo = 0;
    for (let k = 0; k < px.length; k++) {
      brillo += px[k];
      if (k % 64) bordes += Math.abs(px[k] - px[k - 1]);
      if (k >= 64) bordes += Math.abs(px[k] - px[k - 64]);
    }
    brillo /= px.length;
    return bordes / px.length + Math.max(0, brillo - 150) * 0.6; // fondo muy claro: penaliza
  };
  return puntaje(w - zw) <= puntaje(0) ? "derecha" : "izquierda";
}

export function marcarImagen(ruta, original, c = cfg()) {
  const m = c.marca_agua;
  if (!m?.imagen) return false;
  if (yaMarcada(original, c)) return false;
  const [w, h] = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", ruta], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
  const ancho = Math.round(w * (m.ancho ?? 0.3) * (h > w ? 1.25 : 1)); // en verticales, un poco más grande relativo al ancho
  const mg = Math.round(Math.min(w, h) * 0.025);
  const lado = esquinaLibre(ruta, w, h);
  const x = lado === "derecha" ? `W-w-${mg}` : `${mg}`;
  const ext = (ruta.match(/\.\w+$/) ?? [".jpg"])[0];
  const tmp = ruta.slice(0, -ext.length) + ".marca" + ext;
  const filtro = `[1]scale=${ancho}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=${m.opacidad ?? 0.75}[mk];[0][mk]overlay=${x}:H-h-${mg}`;
  const calidad = /\.jpe?g$/i.test(ext) ? ["-q:v", "2"] : [];
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", ruta, "-i", resolve(RAIZ, m.imagen), "-filter_complex", filtro, "-map_metadata", "-1", ...calidad, "-frames:v", "1", tmp]);
  if (r.status !== 0 || !existsSync(tmp)) throw new Error(`No pude poner la marca de agua: ${r.stderr?.toString().slice(0, 300)}`);
  renameSync(tmp, ruta);
  return lado;
}


// Personajes que la marca no hace ni recomienda en ninguna red (pueden parecer menores; docs/rule34.md): una sola
// lista para Rule34, Pixiv y el panel. Incluye las skins (lulu_the_fae_sorceress) y las etiquetas en japonés de Pixiv.
export const PROHIBIDOS = new Set(["yordle", "tristana", "lulu", "poppy", "teemo", "vex", "veigar", "corki", "heimerdinger", "kennen", "rumble", "ziggs", "gnar", "kled", "yuumi", "norra", "smolder", "annie", "zoe"]);
const PROHIBIDOS_JA = ["ヨードル", "ルル", "ポッピー", "トリスターナ", "ティーモ", "ヴェックス", "ベイガー", "ユーミ", "ハイマーディンガー", "ケネン", "ランブル", "ジグス", "ナー", "クレッド", "コーキ", "ノラ", "スモルダー", "アニー", "ゾーイ"];
export function prohibido(tag) {
  const t = String(tag ?? "").toLowerCase().replace(/[ _]?\((lol|league_of_legends|league of legends)\)$/, "").trim();
  return [...PROHIBIDOS].some((n) => t === n || t.startsWith(`${n}_`) || t.startsWith(`${n} `)) || PROHIBIDOS_JA.some((n) => t === n || t.startsWith(`${n}(`));
}

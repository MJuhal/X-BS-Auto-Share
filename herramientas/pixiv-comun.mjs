// Pixiv: rutas, personajes de Patreon, imágenes disponibles, lotes, control de textos, fechas y huella.
// Reglas de la persona a cargo (2026-11-17):
//   - las imágenes salen siempre del Backlog, son SFW y llevan marca de agua visible (sin marca no se publican);
//   - cada post lleva exactamente 3 imágenes del mismo personaje;
//   - manda Patreon: primero los personajes que tienen pack en el banco (carpeta con su nombre);
//   - una imagen puede salir una vez en X y una vez en Pixiv (el registro de usadas es aparte por red).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { carpetas, cfg, hoyEn, imagenes, instante, leer, personajeExcluido, prohibidaPorNombre, RAIZ, shaArchivo, sumarDias } from "./comun.mjs";

export const POR_POST = 3;
// Modo auto: a la hora de la franja se intenta subir; si falla, 3 reintentos cada 15 minutos.
// Pasada esa ventana (o agotados los intentos) el post queda pendiente y lo sube la persona a cargo a mano, con su clic final.
export const INTENTOS_AUTO = 4; // el primero + 3 reintentos
export const VENTANA_AUTO_MS = 50 * 60e3; // franja, +15, +30 y +45 minutos

/** ¿Este post aprobado tiene que subirlo la persona a cargo a mano? (su franja ya pasó y no salió solo). */
export function manualPixiv(p, e, cp, ahora = Date.now()) {
  if (!p.fecha || ["PUBLICADO", "SUBIENDO"].includes(e?.estado)) return false;
  const ms = instante(p.fecha, p.hora, p.zona ?? cp.zona).getTime();
  if (ms > ahora) return false;
  return cp.modo !== "auto" || e?.estado === "FALLIDO" || ahora > ms + VENTANA_AUTO_MS || (e?.intentos ?? 0) >= INTENTOS_AUTO;
}
export const ETIQUETAS = leer(join(RAIZ, "docs/pixiv-etiquetas.json"));
const PROHIBIDAS = leer(join(RAIZ, "docs/palabras-prohibidas.json"));

/** Configuración de Pixiv con valores por defecto. */
export function confPixiv(c = cfg()) {
  const p = c.pixiv ?? {};
  const pub = carpetas(c).nuevas;
  const horas = [...(p.horas ?? [p.hora ?? "21:00"])].sort();
  return {
    activa: p.activa ?? false,
    usuario_id: p.usuario_id ?? "",
    perfil: p.perfil ?? (p.usuario_id ? `https://www.pixiv.net/en/users/${p.usuario_id}` : ""),
    horas, // franjas diarias (hora de Japón); la persona a cargo 2026-11-18: 3 posts por día
    // Cambios de horario con fecha de inicio: [{ desde, horas }].
    cambios_horas: [...(p.cambios_horas ?? [])].sort((a, b) => a.desde.localeCompare(b.desde)),
    // Todas las horas que pueden tener un post (las de antes y las de los cambios): la tarea de Windows corre en todas.
    todas_horas: [...new Set([...horas, ...(p.cambios_horas ?? []).flatMap((x) => x.horas)])].sort(),
    hora: horas[0],
    zona: p.zona ?? "Asia/Tokyo",
    posts_por_lote: p.posts_por_lote ?? 9,
    modo: p.modo ?? "confirmar", // confirmar = la persona a cargo toca Publicar; auto = publica solo (fase 2)
    lotes: p.lotes ?? join(pub, "Lotes-Pixiv"),
    banco: p.banco ?? dirname(pub), // carpeta con una subcarpeta por personaje de Patreon
    // Desde 2026-11-23 el banco está repartido (Personajes LOL y Packs en conjunto): config pixiv.bancos.
    bancos: p.bancos ?? [p.banco ?? dirname(pub)],
    // Ventana de publicación: instantes ISO; fuera de ahí no se agenda.
    ventana: p.ventana ?? null,
    generar_si_quedan: p.generar_si_quedan ?? 6,
  };
}

/** Franjas de Pixiv de un día (hora de Japón): las de config pixiv.horas o las del último cambio que ya empezó. */
export function horasPixivEn(fecha, cp) {
  return [...(cp.cambios_horas.filter((x) => x.desde <= fecha).at(-1)?.horas ?? cp.horas)].sort();
}

/** Personaje de un archivo del Backlog: "<campeón>-sfw-cute-N". */
export const personajeArchivo = (f) => basename(f).toLowerCase().split("-")[0];

/** Personajes con pack en Patreon: carpetas del banco con un solo nombre (Ahri, Aurora...) que tengan
 *  subcarpetas de pack. Las carpetas combinadas ("Noxus - Leblanc-Katarina-Bronze") suman sus nombres. */
export function personajesPatreon(c = cfg()) {
  const set = new Set();
  const alias = { arhi: "ahri" };
  for (const banco of confPixiv(c).bancos) for (const d of existsSync(banco) ? readdirSync(banco) : []) {
    if (/^(publicaciones|sfw)$/i.test(d) || !statSync(join(banco, d)).isDirectory()) continue;
    // Pack = subcarpeta "Pack…" o cualquier subcarpeta con imágenes que no sea la SFW (Akali: "Nude Selfplay", 2026-11-23).
    const packs = readdirSync(join(banco, d)).filter((x) => statSync(join(banco, d, x)).isDirectory() && (/^pack/i.test(x) || (!/^sfw$/i.test(x) && imagenes(join(banco, d, x)).length)));
    if (!packs.length && !imagenes(join(banco, d)).length) continue; // Sona: el pack está suelto en su carpeta (2026-11-23)
    const nombres = d.includes(" - ") ? d.split(" - ")[1].split("-").slice(0, -1) : [d];
    for (const n of nombres) set.add(alias[n.toLowerCase()] ?? n.toLowerCase());
  }
  return set;
}

export const dirLotesPixiv = (c = cfg()) => confPixiv(c).lotes;

/** Lotes de Pixiv (carpetas con lote.json), del más viejo al más nuevo. */
export function lotesPixiv(c = cfg()) {
  const dir = dirLotesPixiv(c);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, "lote.json"))).sort().map((d) => join(dir, d));
}

export const estadoPixiv = (dir) => (existsSync(join(dir, "estado.json")) ? leer(join(dir, "estado.json")) : { piezas: {} });

/** Originales ya usados en Pixiv (o rechazados para Pixiv), por SHA-256. */
export function usadasPixiv(c = cfg()) {
  const set = new Set();
  for (const d of lotesPixiv(c)) for (const p of leer(join(d, "lote.json")).piezas) for (const i of p.imagenes ?? []) if (i.sha256_original) set.add(i.sha256_original);
  const rech = join(dirLotesPixiv(c), "rechazadas.json");
  if (existsSync(rech)) for (const r of leer(rech)) set.add(r.sha256);
  return set;
}

/** Imágenes del Backlog todavía sin usar en Pixiv, agrupadas por personaje. */
export function disponiblesPixiv(c = cfg()) {
  const ya = usadasPixiv(c);
  const grupos = new Map();
  for (const f of imagenes(carpetas(c).backlog)) {
    if (prohibidaPorNombre(f) || personajeExcluido(f, c) || ya.has(shaArchivo(f))) continue;
    const k = personajeArchivo(f);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(f);
  }
  return grupos;
}

/** Stock por personaje (para el panel): { personaje, patreon, imagenes, posts }. Patreon primero. */
export function stockPixiv(c = cfg()) {
  const pat = personajesPatreon(c);
  return [...disponiblesPixiv(c)].map(([personaje, fs]) => ({ personaje, patreon: pat.has(personaje), imagenes: fs.length, posts: Math.floor(fs.length / POR_POST) }))
    .sort((a, b) => b.patreon - a.patreon || b.imagenes - a.imagenes);
}

export const publicablesPixiv = (lote) => lote.piezas.filter((p) => !p.bloqueada);

/** Etiquetas finales de una pieza: franquicia + personaje + IA + descriptivas (máximo 10, sin repetir). */
export function etiquetasDe(p) {
  // Cada post nuevo guarda sus etiquetas de personaje al generarse;
  // los lotes de antes siguen con las anteriores, así su aprobación no cambia.
  const k = (p.personaje ?? "").toLowerCase();
  const pj = p.etiquetas_personaje ?? (ETIQUETAS.personajes_anteriores ?? ETIQUETAS.personajes)[k] ?? ETIQUETAS.personajes[k] ?? [];
  const todas = [...ETIQUETAS.franquicia, ...pj, ETIQUETAS.ia, ...(p.etiquetas_extra ?? [])].map((t) => String(t).trim().replace(/\s+/g, "_")).filter(Boolean);
  return [...new Set(todas)].slice(0, 10);
}

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Control automático de una pieza de Pixiv. Devuelve la lista de problemas (vacía = ok). */
export function controlarPixiv(p) {
  const out = [];
  if ((p.imagenes ?? []).length !== POR_POST) out.push(`tiene ${(p.imagenes ?? []).length} imágenes (tienen que ser exactamente ${POR_POST})`);
  const titulo = (p.titulo ?? "").trim(), desc = (p.descripcion ?? "").trim();
  if (!titulo) out.push("sin título");
  if ([...titulo].length > 32) out.push(`título de ${[...titulo].length} caracteres (máximo 32)`);
  if (!desc) out.push("sin descripción");
  if (desc.length > 3000) out.push("descripción de más de 3000 caracteres");
  if (/https?:\/\/|www\./i.test(desc + titulo)) out.push("tiene un link escrito (el link a Patreon está en el perfil: decir \"link in profile\")");
  if (/(^|\s)@\w/.test(desc)) out.push("menciona una cuenta (@)");
  const bajo = `${titulo} ${desc} ${(p.etiquetas_extra ?? []).join(" ")}`.toLowerCase();
  for (const [grupo, lista] of Object.entries(PROHIBIDAS)) {
    if (grupo.startsWith("_")) continue;
    // En Pixiv el personaje y el juego van en las etiquetas: de "terceros" solo se controla "patreon" (se dice "link in profile").
    for (const w of grupo === "terceros" ? ["patreon"] : lista) if (new RegExp(`(^|[^a-z0-9])${escapar(w)}([^a-z0-9]|$)`, "i").test(bajo)) out.push(`palabra no permitida (${grupo}): "${w}"`);
  }
  if (/少女|ロリ|幼|子供|JK|学生|制服/i.test(bajo)) out.push("etiqueta o texto que sugiere minoría de edad");
  const pj = (p.personaje ?? "").toLowerCase();
  if (!pj) out.push("sin personaje");
  else if (!ETIQUETAS.personajes[pj] && pj !== "original") out.push(`personaje sin etiquetas cargadas en docs/pixiv-etiquetas.json (${p.personaje})`);
  if ((p.etiquetas_extra ?? []).length > 3) out.push("más de 3 etiquetas descriptivas");
  if (typeof p.sugerente !== "boolean") out.push("falta decidir \"Adult content\" (sugerente o no)");
  return out;
}

/** Huella de lo que la persona a cargo aprueba: título, descripción, etiquetas, fecha, hora e imágenes de cada pieza. */
export function huellaPixiv(dir) {
  const lote = leer(join(dir, "lote.json"));
  const piezas = publicablesPixiv(lote).map((p) => ({ n: p.n, titulo: p.titulo, descripcion: p.descripcion, etiquetas: etiquetasDe(p), sugerente: p.sugerente, fecha: p.fecha, hora: p.hora, zona: p.zona, imgs: p.imagenes.map((i) => i.sha256) }));
  return createHash("sha256").update(JSON.stringify(piezas)).digest("hex");
}

export const aprobadoPixiv = (dir) => existsSync(join(dir, "aprobacion.json")) && leer(join(dir, "aprobacion.json")).huella === huellaPixiv(dir);

const NO_SALE = ["FALLIDO", "VENCIDO", "BLOQUEADO"];

/** Franjas ya ocupadas por posts de Pixiv aprobados (o ya publicados): "fecha hora" → personaje. */
export function diasOcupadosPixiv(c = cfg(), excluir = null) {
  const m = new Map();
  for (const d of lotesPixiv(c)) {
    if (d === excluir) continue;
    const est = estadoPixiv(d).piezas;
    const ok = aprobadoPixiv(d);
    for (const p of publicablesPixiv(leer(join(d, "lote.json")))) {
      const e = est[p.n]?.pixiv;
      if (p.fecha && (e?.estado === "PUBLICADO" || (ok && !NO_SALE.includes(e?.estado)))) m.set(`${p.fecha} ${p.hora}`, (p.personaje ?? "").toLowerCase());
    }
  }
  return m;
}

/** Franjas de Pixiv de los próximos `dias` días (hora de Japón), en orden: [{ fecha, hora, clave, ms }]. */
export function franjasPixiv(c = cfg(), dias = 60, desde = hoyEn(confPixiv(c).zona)) {
  const cp = confPixiv(c);
  const out = [];
  for (let i = 0; i < dias; i++) {
    const fecha = sumarDias(desde, i);
    for (const hora of horasPixivEn(fecha, cp)) out.push({ fecha, hora, clave: `${fecha} ${hora}`, ms: instante(fecha, hora, cp.zona).getTime() });
  }
  return out;
}

/** Asigna una franja a cada pieza publicable: las franjas libres desde ahora (como mínimo 30 minutos adelante),
 *  sin pisar las ocupadas por otros lotes. Nunca dos posts seguidos del mismo personaje (si el lote no da, avisa). */
export function asignarFechasPixiv(lote, c = cfg()) {
  const cp = confPixiv(c);
  const ocupados = diasOcupadosPixiv(c, lote.__dir ?? null);
  for (const p of lote.piezas) if (p.bloqueada) Object.assign(p, { fecha: null, hora: null, zona: null });
  const pend = lote.piezas.filter((p) => !p.bloqueada);
  const franjas = franjasPixiv(c, Math.max(30, pend.length * 2));
  const v = cp.ventana, dentro = (ms) => (!v?.desde || ms >= Date.parse(v.desde)) && (!v?.hasta || ms < Date.parse(v.hasta));
  const asignado = new Map(); // clave → personaje (las de este lote)
  const pjEn = (k) => asignado.get(k) ?? ocupados.get(k) ?? null;
  for (let i = 0; i < franjas.length && pend.length; i++) {
    const f = franjas[i];
    if (ocupados.has(f.clave) || f.ms < Date.now() + 30 * 60e3 || !dentro(f.ms)) continue;
    const previo = i > 0 ? pjEn(franjas[i - 1].clave) : null;
    const siguiente = i + 1 < franjas.length ? ocupados.get(franjas[i + 1].clave) ?? null : null;
    const cuenta = new Map();
    for (const p of pend) cuenta.set(p.personaje, (cuenta.get(p.personaje) ?? 0) + 1);
    const pj = (p) => (p.personaje ?? "").toLowerCase();
    const ideales = pend.filter((p) => pj(p) !== previo && pj(p) !== siguiente);
    const distintos = pend.filter((p) => pj(p) !== previo);
    const p = (ideales.length ? ideales : distintos.length ? distintos : pend).sort((a, b) => cuenta.get(b.personaje) - cuenta.get(a.personaje) || a.n - b.n)[0];
    pend.splice(pend.indexOf(p), 1);
    Object.assign(p, { fecha: f.fecha, hora: f.hora, zona: cp.zona });
    asignado.set(f.clave, pj(p));
  }
  return lote;
}

/** Posts de Pixiv aprobados que todavía no salieron. */
export function porSalirPixiv(c = cfg()) {
  let n = 0;
  for (const d of lotesPixiv(c)) {
    if (!aprobadoPixiv(d)) continue;
    const est = estadoPixiv(d).piezas;
    for (const p of publicablesPixiv(leer(join(d, "lote.json")))) if (p.fecha && !["PUBLICADO", ...NO_SALE].includes(est[p.n]?.pixiv?.estado)) n++;
  }
  return n;
}

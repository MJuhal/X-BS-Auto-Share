// Registro de interacción en Bluesky: lo que la persona a cargo confirmó en el panel ("Seguida", "Hecho") y
// lo que Bluesky dice que ya hizo la cuenta de marca (a quién sigue, a qué posts respondió). Sirve para no volver a
// sugerir lo mismo. Se guarda en config/bsky/registro.json y se lee cómodo en config/bsky/registro.md.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, guardar, leer, RAIZ } from "./comun.mjs";

export const DIR_BSKY = join(RAIZ, "config/bsky");
const RUTA_JSON = join(DIR_BSKY, "registro.json");
const RUTA_MD = join(DIR_BSKY, "registro.md");
const PUBLICA = "https://public.api.bsky.app/xrpc";
export const PROPIO = cfg().publicacion.bluesky?.canal?.handle || "sin-cuenta.bsky.social";

export const leerRegistro = () => (existsSync(RUTA_JSON) ? leer(RUTA_JSON) : { cuentas: [], posts: [], bluesky: null });

/** Anota (o saca, con estado "pendiente") una confirmación de la persona a cargo y regenera el .md. */
export function anotar(tipo, item, estado) {
  mkdirSync(DIR_BSKY, { recursive: true });
  const r = leerRegistro();
  const lista = tipo === "cuenta" ? r.cuentas : r.posts;
  const clave = tipo === "cuenta" ? "did" : "uri";
  const i = lista.findIndex((x) => x[clave] === item[clave]);
  if (i >= 0) lista.splice(i, 1);
  if (estado === "hecho") lista.push(tipo === "cuenta"
    ? { did: item.did, handle: item.handle, nombre: item.nombre ?? null, link: item.link, fecha: item.cuando ?? new Date().toISOString() }
    : { uri: item.uri, did: item.did, handle: item.handle, link: item.link, respuesta: item.respuesta ?? null, fecha: item.cuando ?? new Date().toISOString() });
  guardar(RUTA_JSON, r);
  escribirMd(r);
}

/** Lo que Bluesky dice que hizo la cuenta de marca: a quién sigue y a qué posts respondió (API pública, solo lectura). */
export async function sincronizarConBluesky() {
  const r = leerRegistro();
  const sigue = [];
  let cursor = "";
  for (let i = 0; i < 30; i++) {
    const j = await (await fetch(`${PUBLICA}/app.bsky.graph.getFollows?actor=${PROPIO}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
    sigue.push(...(j.follows ?? []).map((f) => ({ did: f.did, handle: f.handle })));
    if (!j.cursor) break;
    cursor = j.cursor;
  }
  const respondidos = [];
  cursor = "";
  for (let i = 0; i < 5; i++) {
    const j = await (await fetch(`${PUBLICA}/app.bsky.feed.getAuthorFeed?actor=${PROPIO}&filter=posts_with_replies&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
    for (const it of j.feed ?? []) {
      const par = it.reply?.parent;
      if (it.post?.author?.handle === PROPIO && par?.uri) respondidos.push({ uri: par.uri, did: par.author?.did ?? null, handle: par.author?.handle ?? null, fecha: it.post.indexedAt });
    }
    if (!j.cursor) break;
    cursor = j.cursor;
  }
  r.bluesky = { revisado: new Date().toISOString(), sigue, respondidos };
  guardar(RUTA_JSON, r);
  escribirMd(r);
  return r;
}

/** Exclusiones para las sugerencias: cuentas seguidas, posts respondidos y autores respondidos en los últimos días. */
export function exclusiones(r = leerRegistro(), dias = 14) {
  const limite = Date.now() - dias * 86400e3;
  const resp = [...r.posts, ...(r.bluesky?.respondidos ?? [])];
  return {
    cuentas: new Set([...r.cuentas.map((c) => c.did), ...(r.bluesky?.sigue ?? []).map((c) => c.did)]),
    posts: new Set(resp.map((p) => p.uri)),
    autores: new Set(resp.filter((p) => Date.parse(p.fecha) > limite).map((p) => p.did).filter(Boolean)),
  };
}

function escribirMd(r) {
  const f = (iso) => (iso ? new Date(iso).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "");
  const esc = (s) => String(s ?? "").replace(/\|/g, "/").replace(/\r?\n/g, " ");
  const enPanel = new Set(r.cuentas.map((c) => c.did));
  const fuera = (r.bluesky?.sigue ?? []).filter((c) => !enPanel.has(c.did));
  const md = [
    "# Registro de Bluesky | la marca",
    "",
    "Se actualiza solo: con cada \"Seguida\" o \"Hecho\" del panel y con lo que dice Bluesky al buscar sugerencias. Lo que está acá no se vuelve a sugerir.",
    r.bluesky ? `\nSegún Bluesky (${f(r.bluesky.revisado)}): seguís a ${r.bluesky.sigue.length} cuentas y respondiste ${r.bluesky.respondidos.length} posts.` : "",
    "",
    `## Cuentas seguidas desde el panel (${r.cuentas.length})`,
    "",
    "| Fecha | Cuenta | Link |",
    "|---|---|---|",
    ...[...r.cuentas].reverse().map((c) => `| ${f(c.fecha)} | ${esc(c.nombre ?? c.handle)} (@${esc(c.handle)}) | ${c.link} |`),
    "",
    `## Posts respondidos desde el panel (${r.posts.length})`,
    "",
    "| Fecha | Autor | Respuesta sugerida | Link |",
    "|---|---|---|---|",
    ...[...r.posts].reverse().map((p) => `| ${f(p.fecha)} | @${esc(p.handle)} | ${esc(p.respuesta)} | ${p.link} |`),
    "",
    `## Otras cuentas que seguís (según Bluesky, fuera del panel) (${fuera.length})`,
    "",
    ...fuera.map((c) => `- @${c.handle} | https://bsky.app/profile/${c.handle}`),
    "",
  ].join("\n");
  writeFileSync(RUTA_MD, md);
}

// Asistente de interacción en Bluesky. Con la API pública y
// oficial de Bluesky (sin cuenta) busca posts recientes del nicho para responder y cuentas para seguir, y la IA
// Code escribe una respuesta sugerida para cada post. NO interactúa: la persona a cargo responde y sigue a mano.
// Respeta a quien pidió no ser visto sin sesión (etiqueta "!no-unauthenticated") y saltea contenido etiquetado como
// adulto o gráfico.
//   node herramientas/bsky-sugerencias.mjs   arma las sugerencias en config/bsky/<fecha>.json
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nombraMarca, cfg, guardar, hoyEn, leer, RAIZ } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";
import { exclusiones, sincronizarConBluesky } from "./bsky-registro.mjs";
import { personajesPatreon } from "./pixiv-comun.mjs";

export const DIR_BSKY = join(RAIZ, "config/bsky");
const API = "https://api.bsky.app/xrpc";
const PUBLICA = "https://public.api.bsky.app/xrpc";
const PROPIO = cfg().publicacion.bluesky?.canal?.handle || "sin-cuenta.bsky.social";
// Criterios: los posts más nuevos (no los más populares) de las últimas 24 h, porque una
// respuesta temprana se ve más; búsquedas por los personajes con pack en Patreon (salen del banco: si se suma un
// pack, se busca solo) y Arcane; autores de 500 seguidores o más.
const POSTS = 16, CUENTAS = 8, HORAS = 24, DIAS_SIN_REPETIR = 14, MIN_LIKES = 3, MIN_SEGUIDORES = 500;
// Los personajes van por nombre solo ("ahri fanart" casi no trae nada en 24 h). Los nombres que comparten otras
// cosas (Nami de One Piece, auroras) solo valen si el post menciona League of Legends o Arcane.
const PERSONAJES = [...personajesPatreon()];
const AMBIGUOS = new Set(["nami", "aurora", "sona", "kayle", "fiora", "irelia"]);
const DE_LOL = /league|lol|arcane|riot|runeterra|#lol/i;
const BUSQUEDAS_POSTS = [...PERSONAJES, "#Arcane", "#lolfanart", "#LeagueOfLegends", "#AIart anime", "#animeart", "#AIイラスト"];
const BUSQUEDAS_CUENTAS = ["anime artist", "league of legends fanart", "AI anime art", "anime illustrator", "waifu art"];
const NO = new Set(["!no-unauthenticated", "porn", "sexual", "nudity", "graphic-media", "gore", "!hide", "!warn"]);

const hoy = hoyEn("America/Argentina/Buenos_Aires");
const dirHoy = join(DIR_BSKY, hoy);
mkdirSync(dirHoy, { recursive: true });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`Bluesky ${r.status} en ${url.split("xrpc/")[1]?.split("?")[0]}`); return r.json(); };
const etiquetas = (x) => (x?.labels ?? []).map((l) => l.val);
const linkPost = (p) => `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split("/").pop()}`;

// Historial: un post o una cuenta ya sugeridos no vuelven; un autor no se repite en 14 días.
const archivos = readdirSync(DIR_BSKY).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const historial = archivos.map((f) => leer(join(DIR_BSKY, f)));
const vistos = new Set(historial.flatMap((d) => [...d.posts.map((p) => p.uri), ...d.cuentas.map((c) => c.did)]));
const limite = new Date(Date.now() - DIAS_SIN_REPETIR * 86400e3).toISOString().slice(0, 10);
const autoresRecientes = new Set(historial.filter((d) => d.fecha >= limite).flatMap((d) => d.posts.map((p) => p.did)));
const anterior = historial.at(-1) ?? null;
const ruta = join(DIR_BSKY, `${hoy}.json`);
// Siguen a la vista: del mismo día, todo; de antes, lo pendiente que no venció (posts de menos de 3 días).
const conservar = (lista, vigente) => (anterior?.[lista] ?? []).filter((x) => anterior.fecha === hoy || (x.estado === "pendiente" && vigente(x)));
let postsPrevios = conservar("posts", (p) => Date.now() - Date.parse(p.fecha_post) < 3 * 86400e3);
let cuentasPrevias = conservar("cuentas", () => true);
const respuestasPrevias = historial.flatMap((d) => d.posts.map((p) => p.respuesta).filter(Boolean)).slice(-60);
// Registro: lo confirmado en el panel y lo que Bluesky dice que ya hizo la cuenta (a quién sigue,
// a qué posts respondió, también fuera del panel). Nada de eso se vuelve a sugerir.
try { await sincronizarConBluesky(); } catch (e) { console.log(`No pude consultar a quién seguís en Bluesky: ${e.message}`); }
const ex = exclusiones();
for (const d of ex.cuentas) vistos.add(d);
for (const u of ex.posts) vistos.add(u);
for (const d of ex.autores) autoresRecientes.add(d);
console.log(`Excluidos: ${ex.cuentas.size} cuentas que ya seguís, ${ex.posts.size} posts respondidos, ${ex.autores.size} autores respondidos hace poco.`);

// 1) Posts para responder: recientes, con imagen, con algo de movimiento y de autores con un público razonable.
const candidatos = new Map();
for (const q of BUSQUEDAS_POSTS) {
  console.log(`Busco posts: ${q}`);
  try {
    const j = await get(`${API}/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=100&sort=latest`);
    for (const p of j.posts ?? []) {
      const img = p.embed?.images?.[0]?.thumb ?? p.embed?.media?.images?.[0]?.thumb;
      const horas = (Date.now() - Date.parse(p.indexedAt)) / 3600e3;
      if (!img || horas > HORAS || p.author.handle === PROPIO || vistos.has(p.uri) || autoresRecientes.has(p.author.did)) continue;
      if ([...etiquetas(p), ...etiquetas(p.author)].some((l) => NO.has(l))) continue;
      if ((p.likeCount ?? 0) < MIN_LIKES) continue;
      if (AMBIGUOS.has(q) && !DE_LOL.test(`${p.record?.text ?? ""} ${(p.record?.facets ?? []).flatMap((f) => f.features ?? []).map((x) => x.tag ?? "").join(" ")}`)) continue;
      if (!candidatos.has(p.uri)) candidatos.set(p.uri, { p, img, q });
    }
  } catch (e) { console.log(e.message); }
  await espera(800);
}
// Una sola por autor, ordenadas por movimiento (likes + respuestas x3), y que el autor no sea gigante (ahí una
// respuesta se pierde) ni minúsculo.
const porAutor = new Map();
for (const c of [...candidatos.values()].sort((a, b) => (b.p.likeCount + 3 * b.p.replyCount) - (a.p.likeCount + 3 * a.p.replyCount))) if (!porAutor.has(c.p.author.did)) porAutor.set(c.p.author.did, c);
const dids = [...porAutor.keys()];
const perfiles = new Map();
for (let i = 0; i < dids.length; i += 25) {
  try { for (const pr of (await get(`${PUBLICA}/app.bsky.actor.getProfiles?${dids.slice(i, i + 25).map((d) => `actors=${encodeURIComponent(d)}`).join("&")}`)).profiles) perfiles.set(pr.did, pr); } catch (e) { console.log(e.message); }
}
const posts = [];
for (const { p, img, q } of porAutor.values()) {
  if (posts.length >= POSTS) break;
  const seg = perfiles.get(p.author.did)?.followersCount ?? 0;
  if (seg < MIN_SEGUIDORES || seg > 150000) continue;
  const mini = join(dirHoy, `${p.uri.split("/").pop()}.jpg`);
  try { writeFileSync(mini, Buffer.from(await (await fetch(img)).arrayBuffer())); } catch { continue; }
  posts.push({ uri: p.uri, did: p.author.did, handle: p.author.handle, autor: p.author.displayName || p.author.handle, seguidores: seg, link: linkPost(p), texto: [...(p.record?.text ?? "")].slice(0, 300).join(""), likes: p.likeCount ?? 0, respuestas: p.replyCount ?? 0, fecha_post: p.indexedAt, busqueda: q, mini, estado: "pendiente", respuesta: null, por_que: null, saltar: false, nota: null });
}

// 2) Cuentas para seguir: autores activos del nicho que aparecieron en las búsquedas (y no se eligieron para
// responder), con público mediano: más chances de que miren y devuelvan. La búsqueda de cuentas por palabras traía
// cualquier cosa (museos, revistas), así que solo completa si faltan.
const cuentas = [];
const yaElegidas = new Set(posts.map((p) => p.did));
const agregarCuenta = (pr, origen) => {
  if (cuentas.length >= CUENTAS || !pr || pr.handle === PROPIO || vistos.has(pr.did) || yaElegidas.has(pr.did) || etiquetas(pr).some((l) => NO.has(l))) return;
  if ((pr.followersCount ?? 0) < 300 || pr.followersCount > 80000 || (pr.postsCount ?? 0) < 30) return;
  cuentas.push({ did: pr.did, handle: pr.handle, nombre: pr.displayName || pr.handle, seguidores: pr.followersCount, siguiendo: pr.followsCount, posts: pr.postsCount, bio: (pr.description ?? "").slice(0, 200), link: `https://bsky.app/profile/${pr.handle}`, busqueda: origen, estado: "pendiente", por_que: null, saltar: false });
  yaElegidas.add(pr.did);
};
for (const [did, c] of porAutor) agregarCuenta(perfiles.get(did), `publicó con ${c.q}`);
for (const q of BUSQUEDAS_CUENTAS) {
  if (cuentas.length >= CUENTAS) break;
  console.log(`Busco cuentas: ${q}`);
  try {
    const j = await get(`${PUBLICA}/app.bsky.actor.searchActors?q=${encodeURIComponent(q)}&limit=25`);
    const ids = (j.actors ?? []).map((a) => a.did).filter((d) => !vistos.has(d) && !yaElegidas.has(d)).slice(0, 25);
    if (ids.length) for (const pr of (await get(`${PUBLICA}/app.bsky.actor.getProfiles?${ids.map((d) => `actors=${encodeURIComponent(d)}`).join("&")}`)).profiles) if (pr.description) agregarCuenta(pr, `búsqueda "${q}"`);
  } catch (e) { console.log(e.message); }
  await espera(800);
}

postsPrevios = postsPrevios.filter((p) => p.estado !== "pendiente" || !ex.posts.has(p.uri));
cuentasPrevias = cuentasPrevias.filter((c) => c.estado !== "pendiente" || !ex.cuentas.has(c.did));
guardar(ruta, { fecha: hoy, generado: new Date().toISOString(), nuevas: posts.length + cuentas.length, posts: [...postsPrevios, ...posts], cuentas: [...cuentasPrevias, ...cuentas] });
guardar(join(dirHoy, "respuestas-previas.json"), respuestasPrevias);

// 3) Respuestas sugeridas y motivo de cada cuenta (la IA mira cada imagen).
// También si quedaron pendientes sin respuesta de una corrida anterior que falló.
const sinRespuesta = [...postsPrevios, ...posts].filter((p) => p.estado === "pendiente" && !p.saltar && !p.respuesta).length;
const sinMotivo = [...cuentasPrevias, ...cuentas].filter((c) => c.estado === "pendiente" && !c.por_que).length;
if (sinRespuesta || sinMotivo) {
  console.log(`== Respuestas para ${sinRespuesta} posts y motivo de ${sinMotivo} cuentas`);
  const prompt = [
    `Leé ${join(RAIZ, "docs/instrucciones-interaccion.md")} y seguilas: valen igual para Bluesky (respuestas cortas de fan, en inglés, voz silly y cute, sin coqueteo ni autopromoción).`,
    `En ${ruta}, para cada post con "respuesta" en null y "saltar" en false: abrí su miniatura (campo "mini"), leé su "texto" y escribí "respuesta" (la respuesta que dejaría la persona a cargo en ese post), "por_que" (en español, una línea) y, si conviene no responder (contenido explícito, posible menor, política, tema delicado), "saltar": true con el motivo en "nota".`,
    `Para cada cuenta con "por_que" en null, escribí "por_que": en español, una línea con por qué seguirla le suma a la marca (nicho, actividad, público), según su bio. Si no es del nicho (anime, fanart de juegos, arte con IA, waifus) o es de una institución, marca o tema ajeno, poné "saltar": true y explicá en "por_que".`,
    `Las respuestas anteriores están en ${join(dirHoy, "respuestas-previas.json")}: no las repitas. No toques otros archivos.`,
  ].join(" ");
  const codigo = await ejecutarIA(prompt, { herramientas: "Read,Edit,Write", dirs: [DIR_BSKY] });
  const final = leer(ruta);
  for (const c of final.cuentas) if (c.saltar && c.estado === "pendiente") c.estado = "descartada"; // no es del nicho
  // Lo que la IA decide saltar va directo al historial (con el motivo): en la vista quedan solo los que se pueden
  // responder. Por eso se buscan 16: suele saltear un tercio o más (sugerente, explícito, posible menor).
  const nuevosUri = new Set(posts.map((p) => p.uri));
  for (const p of final.posts) if (nuevosUri.has(p.uri) && p.saltar && p.estado === "pendiente") { p.estado = "saltado"; p.nota = `Saltado solo: ${p.nota ?? "mejor no responder"}`; }
  for (const p of final.posts) if (p.respuesta && (nombraMarca(p.respuesta) || /https?:|www\.|patreon|follow me|my profile|check my/i.test(p.respuesta))) { p.saltar = true; p.nota = `Respuesta descartada por autopromoción. ${p.nota ?? ""}`.trim(); p.respuesta = null; }
  guardar(ruta, final);
  console.log(codigo === 0 ? "LISTO" : `La redacción terminó con código ${codigo}`);
}
console.log(`Sugerencias: ${posts.length} posts y ${cuentas.length} cuentas nuevas.`);

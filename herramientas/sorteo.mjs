// Sorteos en X, Bluesky y Pixiv. Solo LEE quién participó y elige al azar: no publica, no da like,
// no sigue ni manda mensajes. El anuncio va como post de un lote aprobado y al ganador le escribe la persona a cargo.
//   Bluesky: comentó, like, repost, te sigue, antigüedad de la cuenta. API pública, gratis.
//   Pixiv:   comentó, favoritos (bookmarks públicos), te sigue. Con la sesión del Chrome de Pixiv, solo lectura.
//            Los likes de Pixiv son anónimos: no se pueden usar como condición.
//   X:       comentó, like, repost, te sigue, antigüedad. API paga por uso: primero --estimar (unos centavos) y el
//            panel pide confirmar el costo antes de --revisar. Las respuestas solo se leen hasta 7 días después del post.
//   node herramientas/sorteo.mjs --estimar <id>   (solo X) cuenta interacciones y calcula el costo de revisar
//   node herramientas/sorteo.mjs --revisar <id>   trae participantes y marca quién cumple
//   node herramientas/sorteo.mjs --sortear <id>   elige ganadores y suplentes al azar entre los que cumplen
// Cada sorteo: config/sorteos/<id>.json y un registro legible config/sorteos/<id>.md (participantes, semilla, resultado).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cfg, guardar, leer, RAIZ } from "./comun.mjs";

export const DIR_SORTEOS = join(RAIZ, "config/sorteos");
export const CONDICIONES = {
  bsky: ["comento", "like", "repost", "sigue"],
  pixiv: ["comento", "favorito", "sigue"],
  x: ["comento", "like", "repost", "sigue"],
};
export const NOMBRE_COND = { comento: "comentó", like: "dio like", repost: "reposteó", favorito: "guardó en favoritos", sigue: "te sigue" };
// Precios de la API de X (docs.x.com, 2026-11-18): post leído 0,005; usuario 0,010; seguidores propios 0,001 USD.
export const PRECIO_X = { post: 0.005, usuario: 0.01, seguidor_propio: 0.001 };
const BSKY = "https://public.api.bsky.app/xrpc";
const PROPIO_BSKY = cfg().publicacion.bluesky?.canal?.handle || "sin-cuenta.bsky.social";

export const rutaSorteo = (id) => join(DIR_SORTEOS, `${id}.json`);
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Datos del post a partir del link, según la red. */
export function analizarLink(red, link) {
  if (red === "bsky") { const m = link.match(/bsky\.app\/profile\/([^/]+)\/post\/([a-z0-9]+)/i); return m ? { actor: m[1], rkey: m[2] } : null; }
  if (red === "pixiv") { const m = link.match(/pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/); return m ? { obra: m[1] } : null; }
  if (red === "x") { const m = link.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/); return m ? { tweet: m[1] } : null; }
  return null;
}

// ---------- Bluesky ----------
async function bj(metodo, params) {
  const u = new URL(`${BSKY}/${metodo}`);
  for (const [k, v] of Object.entries(params)) if (v != null) [].concat(v).forEach((x) => u.searchParams.append(k, x));
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Bluesky respondió ${r.status} en ${metodo}`);
  return r.json();
}
async function bjTodas(metodo, params, clave) {
  const out = [];
  let cursor;
  for (let i = 0; i < 100; i++) {
    const j = await bj(metodo, { ...params, limit: 100, cursor });
    out.push(...(j[clave] ?? []));
    if (!j.cursor || !(j[clave] ?? []).length) break;
    cursor = j.cursor;
  }
  return out;
}
async function revisarBsky(s) {
  const yo = (await bj("com.atproto.identity.resolveHandle", { handle: PROPIO_BSKY })).did;
  const gente = new Map();
  const sumar = (a, cond) => {
    if (!a?.did || a.did === yo) return;
    const p = gente.get(a.did) ?? { id: a.did, handle: a.handle, nombre: a.displayName || a.handle, link: `https://bsky.app/profile/${a.handle}` };
    p[cond] = true;
    gente.set(a.did, p);
  };
  let seguidores = null;
  if (s.post) {
    const { actor, rkey } = analizarLink("bsky", s.post);
    const did = actor.startsWith("did:") ? actor : (await bj("com.atproto.identity.resolveHandle", { handle: actor })).did;
    if (did !== yo) throw new Error("El post no es de la cuenta de marca de Bluesky.");
    const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
    if (s.condiciones.includes("like")) for (const l of await bjTodas("app.bsky.feed.getLikes", { uri }, "likes")) sumar(l.actor, "like");
    if (s.condiciones.includes("repost")) for (const a of await bjTodas("app.bsky.feed.getRepostedBy", { uri }, "repostedBy")) sumar(a, "repost");
    if (s.condiciones.includes("comento")) {
      const hilo = (await bj("app.bsky.feed.getPostThread", { uri, depth: 20, parentHeight: 0 })).thread;
      const recorrer = (n) => { for (const r of n?.replies ?? []) { sumar(r.post?.author, "comento"); recorrer(r); } };
      recorrer(hilo);
    }
  }
  if (s.condiciones.includes("sigue") || !s.post) {
    seguidores = await bjTodas("app.bsky.graph.getFollowers", { actor: yo }, "followers");
    const set = new Set(seguidores.map((f) => f.did));
    if (!s.post) for (const f of seguidores) sumar(f, "sigue");
    else for (const p of gente.values()) p.sigue = set.has(p.id);
  }
  // antigüedad y actividad de cada cuenta (para descartar cuentas recién creadas)
  const ids = [...gente.keys()];
  for (let i = 0; i < ids.length; i += 25) {
    const { profiles } = await bj("app.bsky.actor.getProfiles", { actors: ids.slice(i, i + 25) });
    for (const pr of profiles ?? []) Object.assign(gente.get(pr.did), { creada: pr.createdAt ?? null, posts: pr.postsCount ?? null });
  }
  return { participantes: [...gente.values()], total_seguidores: seguidores?.length ?? null };
}

// ---------- Pixiv ----------
async function revisarPixiv(s) {
  const { abrir, cuentaDe } = await import("./pixiv.mjs");
  const yo = String(cfg().pixiv.usuario_id);
  let nav;
  try { nav = await abrir({ visible: false }); }
  catch (e) { throw new Error(`No pude abrir el Chrome de Pixiv (¿se está publicando un post ahora?). Probá en unos minutos. ${e.message}`); }
  try {
    if ((await cuentaDe(nav)) !== yo) throw new Error('No hay sesión de la cuenta de marca en Pixiv: tocá "Iniciar sesión en Pixiv".');
    const pg = (await nav.pages())[0];
    await pg.goto("https://www.pixiv.net/en/", { waitUntil: "domcontentloaded", timeout: 60000 });
    const aj = async (u) => { const j = await pg.evaluate(async (u) => (await fetch(u, { credentials: "include" })).json(), u); if (j.error) throw new Error(`Pixiv: ${j.message || u}`); await espera(600 + Math.random() * 600); return j.body; };
    const gente = new Map();
    const sumar = (uid, nombre, cond) => {
      uid = String(uid);
      if (!uid || uid === yo) return;
      const p = gente.get(uid) ?? { id: uid, handle: uid, nombre: nombre || uid, link: `https://www.pixiv.net/en/users/${uid}` };
      if (nombre && p.nombre === uid) p.nombre = nombre;
      p[cond] = true;
      gente.set(uid, p);
    };
    let seguidores = null;
    if (s.post) {
      const { obra } = analizarLink("pixiv", s.post);
      const d = await aj(`https://www.pixiv.net/ajax/illust/${obra}`);
      if (String(d.userId) !== yo) throw new Error("La obra no es de la cuenta de marca de Pixiv.");
      if (s.condiciones.includes("comento")) {
        for (let off = 0; off < 5000; off += 50) {
          const b = await aj(`https://www.pixiv.net/ajax/illusts/comments/roots?illust_id=${obra}&offset=${off}&limit=50`);
          for (const c of b.comments ?? []) {
            sumar(c.userId, c.userName, "comento");
            if (c.hasReplies) for (let pag = 1; pag < 20; pag++) {
              const r = await aj(`https://www.pixiv.net/ajax/illusts/comments/replies?comment_id=${c.id}&page=${pag}`);
              for (const x of r.comments ?? []) sumar(x.userId, x.userName, "comento");
              if (!r.hasNext) break;
            }
          }
          if (!b.hasNext) break;
        }
      }
      if (s.condiciones.includes("favorito")) {
        // la lista de quién guardó la obra (solo favoritos públicos) está en bookmark_detail, paginada
        for (let p = 1; p <= 100; p++) {
          await pg.goto(`https://www.pixiv.net/bookmark_detail.php?illust_id=${obra}&p=${p}`, { waitUntil: "networkidle2", timeout: 60000 });
          const usuarios = await pg.evaluate(() => {
            const m = new Map();
            for (const a of document.querySelectorAll('a[href*="/users/"][href*="/bookmarks/artworks"]')) {
              const id = a.getAttribute("href").match(/users\/(\d+)/)?.[1];
              if (id && !m.has(id)) m.set(id, a.innerText.trim().replace(/^\d{4}\/\d{2}\/\d{2}/, "").trim());
            }
            return [...m];
          });
          const antes = gente.size;
          for (const [id, nombre] of usuarios) sumar(id, nombre, "favorito");
          if (!usuarios.length || gente.size === antes) break;
          await espera(1500 + Math.random() * 1500);
        }
      }
    }
    if (s.condiciones.includes("sigue") || !s.post) {
      seguidores = [];
      for (let off = 0; off < 20000; off += 24) {
        const b = await aj(`https://www.pixiv.net/ajax/user/${yo}/followers?offset=${off}&limit=24&rest=show`);
        seguidores.push(...(b.users ?? []).map((u) => ({ id: String(u.userId), nombre: u.userName })));
        if ((b.users ?? []).length < 24) break;
      }
      const set = new Set(seguidores.map((u) => u.id));
      if (!s.post) for (const u of seguidores) sumar(u.id, u.nombre, "sigue");
      else for (const p of gente.values()) p.sigue = set.has(p.id);
    }
    return { participantes: [...gente.values()], total_seguidores: seguidores?.length ?? null };
  } finally { await nav.close(); }
}

// ---------- X ----------
const CAMPOS_USUARIO = { "user.fields": "created_at,public_metrics,username,name" };
async function postX(s) {
  const x = await import("./x-api.mjs");
  const ses = x.sesion();
  if (!ses?.id) throw new Error('No hay sesión de X: tocá "Conectar X".');
  if (!s.post) return { x, ses, t: null };
  const { tweet } = analizarLink("x", s.post);
  const t = (await x.get(`/tweets/${tweet}`, { "tweet.fields": "public_metrics,conversation_id,author_id,created_at" })).data;
  if (t.author_id !== ses.id) throw new Error("El post no es de la cuenta de marca de X.");
  return { x, ses, t };
}
async function estimarX(s) {
  const { x, ses, t } = await postX(s);
  const yo = (await x.get(`/users/${ses.id}`, { "user.fields": "public_metrics" })).data;
  const m = t?.public_metrics ?? {};
  const seg = yo.public_metrics.followers_count;
  const c = s.condiciones;
  const partes = {
    like: c.includes("like") ? (m.like_count ?? 0) * PRECIO_X.usuario : 0,
    repost: c.includes("repost") ? (m.retweet_count ?? 0) * PRECIO_X.usuario : 0,
    comento: c.includes("comento") ? (m.reply_count ?? 0) * (PRECIO_X.post + PRECIO_X.usuario) : 0,
    sigue: c.includes("sigue") || !s.post ? seg * PRECIO_X.seguidor_propio : 0,
  };
  const total = Object.values(partes).reduce((a, b) => a + b, 0);
  const viejo = t && Date.now() - Date.parse(t.created_at) > 6.5 * 86400e3;
  return {
    fecha: new Date().toISOString(), likes: m.like_count ?? null, reposts: m.retweet_count ?? null, respuestas: m.reply_count ?? null, seguidores: seg,
    costo_usd: Math.round((total * 1.2 + 0.02) * 100) / 100, // 20 % de margen por paginación y cuentas repetidas
    aviso: viejo && c.includes("comento") ? "El post tiene casi 7 días: X ya no deja leer respuestas más viejas. Revisalo hoy o sacá la condición de comentar." : null,
  };
}
async function revisarX(s) {
  const { x, ses, t } = await postX(s);
  const gente = new Map();
  const sumar = (u, cond) => {
    if (!u?.id || u.id === ses.id) return;
    const p = gente.get(u.id) ?? { id: u.id, handle: u.username, nombre: u.name || u.username, link: `https://x.com/${u.username}` };
    p[cond] = true;
    if (u.created_at) p.creada = u.created_at;
    if (u.public_metrics) p.posts = u.public_metrics.tweet_count;
    gente.set(u.id, p);
  };
  let seguidores = null;
  if (t) {
    if (s.condiciones.includes("like")) for (const u of await x.todas(`/tweets/${t.id}/liking_users`, { max_results: 100, ...CAMPOS_USUARIO })) sumar(u, "like");
    if (s.condiciones.includes("repost")) for (const u of await x.todas(`/tweets/${t.id}/retweeted_by`, { max_results: 100, ...CAMPOS_USUARIO })) sumar(u, "repost");
    if (s.condiciones.includes("comento")) {
      const posts = await x.todas("/tweets/search/recent", { query: `conversation_id:${t.conversation_id}`, max_results: 100, expansions: "author_id", ...CAMPOS_USUARIO });
      const porId = new Map((posts.incluidos ?? []).map((u) => [u.id, u]));
      for (const p of posts) sumar(porId.get(p.author_id) ?? { id: p.author_id, username: p.author_id }, "comento");
    }
  }
  if (s.condiciones.includes("sigue") || !t) {
    seguidores = await x.todas(`/users/${ses.id}/followers`, { max_results: 1000, ...CAMPOS_USUARIO });
    const set = new Set(seguidores.map((u) => u.id));
    if (!t) for (const u of seguidores) sumar(u, "sigue");
    else for (const p of gente.values()) p.sigue = set.has(p.id);
  }
  return { participantes: [...gente.values()], total_seguidores: seguidores?.length ?? null };
}

// ---------- reglas comunes ----------
/** Marca quién cumple. Una cuenta queda afuera si le falta una condición, es más nueva que el mínimo o no tiene posts. */
export function evaluar(s, participantes) {
  const minDias = s.cuenta_min_dias ?? 0;
  for (const p of participantes) {
    const falta = s.condiciones.filter((c) => !p[c]).map((c) => NOMBRE_COND[c]);
    const motivos = [];
    if (falta.length) motivos.push(`no ${falta.join(", no ")}`);
    if (minDias && p.creada && Date.now() - Date.parse(p.creada) < minDias * 86400e3) motivos.push(`cuenta de menos de ${minDias} días`);
    if (p.posts === 0) motivos.push("cuenta sin posts (posible bot)");
    if ((s.excluidos ?? []).includes(p.handle) || (s.excluidos ?? []).includes(p.id)) motivos.push("excluida a mano");
    p.apto = !motivos.length;
    p.motivo = motivos.join("; ") || null;
  }
  return participantes.sort((a, b) => b.apto - a.apto || String(a.handle).localeCompare(String(b.handle)));
}

/** Orden al azar verificable: cada cuenta recibe sha256(semilla:id) y se ordena por ese valor. Con la semilla y la
 *  lista de aptos cualquiera puede rehacer el sorteo y llegar al mismo resultado. */
export function ordenAzar(semilla, ids) {
  return [...ids].map((id) => [id, createHash("sha256").update(`${semilla}:${id}`).digest("hex")]).sort((a, b) => a[1].localeCompare(b[1])).map(([id]) => id);
}

export function escribirMd(s) {
  const f = (iso) => (iso ? new Date(iso).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "");
  const esc = (t) => String(t ?? "").replace(/\|/g, "/").replace(/\r?\n/g, " ");
  const RED = { bsky: "Bluesky", pixiv: "Pixiv", x: "X" }[s.red];
  const ps = s.participantes ?? [];
  const nombre = (id) => { const p = ps.find((x) => x.id === id); return p ? `${esc(p.nombre)} (@${esc(p.handle)}) ${p.link}` : id; };
  const md = [
    `# Sorteo: ${esc(s.titulo)} | ${RED}`,
    "",
    `- Post: ${s.post ?? "sorteo entre seguidores (sin post)"}`,
    `- Condiciones: ${s.condiciones.map((c) => NOMBRE_COND[c]).join(", ")}${s.cuenta_min_dias ? `; cuenta con ${s.cuenta_min_dias} días o más` : ""}`,
    `- Ganadores: ${s.ganadores}${s.suplentes ? ` · suplentes: ${s.suplentes}` : ""}${s.cierre ? ` · cierre: ${f(s.cierre)}` : ""}`,
    s.revisado ? `- Revisado: ${f(s.revisado)} · ${ps.length} participantes · ${ps.filter((p) => p.apto).length} cumplen${s.costo_real_usd != null ? ` · costo aprox. ${s.costo_real_usd} USD` : ""}` : "",
    "",
    ...(s.resultado ? [
      "## Resultado",
      "",
      `Sorteado: ${f(s.resultado.fecha)} · semilla \`${s.resultado.semilla}\``,
      "",
      ...s.resultado.ganadores.map((id, i) => `${i + 1}. **Ganador:** ${nombre(id)}`),
      ...s.resultado.suplentes.map((id, i) => `- Suplente ${i + 1}: ${nombre(id)}`),
      "",
      "Cómo verificarlo: a cada cuenta que cumple se le calcula sha256(\"semilla:id\") y se ordenan de menor a mayor. Los primeros son los ganadores y siguen los suplentes.",
      "",
    ] : []),
    `## Participantes (${ps.length})`,
    "",
    "| Cumple | Cuenta | " + s.condiciones.map((c) => NOMBRE_COND[c]).join(" | ") + " | Motivo | Link |",
    "|---|---|" + s.condiciones.map(() => "---|").join("") + "---|---|",
    ...ps.map((p) => `| ${p.apto ? "Sí" : "No"} | ${esc(p.nombre)} (@${esc(p.handle)}) | ${s.condiciones.map((c) => (p[c] ? "sí" : "no")).join(" | ")} | ${esc(p.motivo ?? "")} | ${p.link} |`),
    "",
  ].join("\n");
  writeFileSync(join(DIR_SORTEOS, `${s.id}.md`), md);
}

async function main() {
  const [modo, id] = [process.argv[2], process.argv[3]];
  if (!/^[a-z0-9-]+$/.test(id ?? "")) throw new Error("Falta el id del sorteo.");
  mkdirSync(DIR_SORTEOS, { recursive: true });
  const ruta = rutaSorteo(id);
  const s = leer(ruta);
  if (modo === "--estimar") {
    if (s.red !== "x") throw new Error("Solo los sorteos de X tienen costo.");
    console.log("Leyendo el post y la cuenta en X (unos centavos)…");
    s.estimacion = await estimarX(s);
    guardar(ruta, s);
    console.log(`Costo estimado de revisar: ${s.estimacion.costo_usd} USD (${s.estimacion.likes} likes, ${s.estimacion.reposts} reposts, ${s.estimacion.respuestas} respuestas, ${s.estimacion.seguidores} seguidores).`);
    if (s.estimacion.aviso) console.log(s.estimacion.aviso);
    return;
  }
  // --finalizar: cierra antes de tiempo. Revisa y sortea seguido, con los participantes de ese momento.
  const finalizar = modo === "--finalizar";
  if (modo === "--revisar" || finalizar) {
    if (s.resultado) throw new Error("Este sorteo ya se sorteó: no se vuelve a revisar.");
    if (s.red === "x" && !s.costo_aprobado) throw new Error("Falta confirmar el costo en el panel.");
    console.log(`Revisando participantes en ${s.red}…`);
    const lector = { bsky: revisarBsky, pixiv: revisarPixiv, x: revisarX }[s.red];
    const r = await lector(s);
    s.participantes = evaluar(s, r.participantes);
    s.total_seguidores = r.total_seguidores;
    s.revisado = new Date().toISOString();
    if (s.red === "x") {
      s.costo_aprobado = false; // cada revisión paga se vuelve a confirmar
      s.costo_real_usd = Math.round((s.participantes.length * PRECIO_X.usuario + (r.total_seguidores ?? 0) * PRECIO_X.seguidor_propio) * 100) / 100;
    }
    guardar(ruta, s);
    escribirMd(s);
    console.log(`${finalizar ? "Revisado" : "LISTO"}: ${s.participantes.length} participantes, ${s.participantes.filter((p) => p.apto).length} cumplen.`);
    if (!finalizar) return;
  }
  if (modo === "--sortear" || finalizar) {
    if (s.resultado) throw new Error("Este sorteo ya se sorteó.");
    if (!s.revisado) throw new Error("Revisá los participantes antes de sortear.");
    const aptos = s.participantes.filter((p) => p.apto).map((p) => p.id).sort();
    if (!aptos.length) throw new Error("Nadie cumple las condiciones.");
    const semilla = randomBytes(16).toString("hex");
    const orden = ordenAzar(semilla, aptos);
    s.resultado = { fecha: new Date().toISOString(), semilla, aptos: aptos.length, ganadores: orden.slice(0, s.ganadores), suplentes: orden.slice(s.ganadores, s.ganadores + (s.suplentes ?? 0)) };
    guardar(ruta, s);
    escribirMd(s);
    console.log(`LISTO: ganador(es): ${s.resultado.ganadores.map((g) => s.participantes.find((p) => p.id === g).handle).join(", ")}`);
    return;
  }
  throw new Error("Modo desconocido.");
}

if (process.argv[1]?.endsWith("sorteo.mjs")) main().catch((e) => { console.error(e.message); process.exitCode = 1; });

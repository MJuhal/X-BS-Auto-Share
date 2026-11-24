// Métricas de Pixiv: vistas, likes, marcadores y comentarios de cada post publicado de la
// cuenta de marca. Solo lectura: usa la sesión del Chrome de Pixiv para leer /ajax/illust/<id> (las obras marcadas
// como sensibles no se ven sin sesión). No interactúa con nada.
//   node herramientas/pixiv-metricas.mjs
// Guarda en el estado.json de cada lote: piezas[n].pixiv.metricas = { vistas, likes, marcadores, comentarios } y
// metricas_fecha. Pide una obra por segundo.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cfg, guardar, leer, RAIZ } from "./comun.mjs";
import { confPixiv, estadoPixiv, lotesPixiv } from "./pixiv-comun.mjs";
import { abrir, cuentaDe } from "./pixiv.mjs";

const c = cfg();
const cp = confPixiv(c);
const objetivos = lotesPixiv(c).flatMap((dir) => Object.entries(estadoPixiv(dir).piezas)
  .filter(([, e]) => e.pixiv?.estado === "PUBLICADO" && e.pixiv.id)
  .map(([n, e]) => ({ dir, n, id: e.pixiv.id })));
if (!objetivos.length) { console.log("No hay posts publicados en Pixiv todavía."); process.exit(0); }

const nav = await abrir({ visible: false });
let ok = 0;
try {
  const id = await cuentaDe(nav);
  if (id !== cp.usuario_id) throw new Error(id ? `La sesión es de otra cuenta (${id}).` : "No hay sesión en Pixiv: tocá \"Iniciar sesión en Pixiv\".");
  const pg = (await nav.pages())[0];
  await pg.goto("https://www.pixiv.net/en/", { waitUntil: "domcontentloaded", timeout: 60000 });
  for (const o of objetivos) {
    const r = await pg.evaluate(async (id) => {
      try { const j = await (await fetch(`/ajax/illust/${id}`, { credentials: "include" })).json(); return j.error ? { error: j.message || "error" } : j.body; } catch (e) { return { error: String(e) }; }
    }, o.id);
    if (r.error || r.userId !== cp.usuario_id) { console.log(`#${o.n} (${o.id}): no pude leerlo (${r.error ?? "no es de la cuenta de marca"})`); continue; }
    const est = estadoPixiv(o.dir); // se relee por si otra cosa lo cambió mientras tanto
    const e = est.piezas[o.n]?.pixiv;
    if (!e) continue;
    e.metricas = { vistas: r.viewCount ?? 0, likes: r.likeCount ?? 0, marcadores: r.bookmarkCount ?? 0, comentarios: r.commentCount ?? 0 };
    e.metricas_fecha = new Date().toISOString();
    guardar(join(o.dir, "estado.json"), est);
    console.log(`${leer(join(o.dir, "lote.json")).lote} #${o.n}: ${e.metricas.vistas} vistas, ${e.metricas.likes} likes, ${e.metricas.marcadores} marcadores, ${e.metricas.comentarios} comentarios`);
    ok++;
    await new Promise((res) => setTimeout(res, 1000));
  }
} finally { await nav.close().catch(() => {}); }
const rutaMet = join(RAIZ, "config/pixiv-metricas.json");
guardar(rutaMet, { ...(existsSync(rutaMet) ? leer(rutaMet) : {}), actualizado: new Date().toISOString(), posts: ok });
console.log(`LISTO: ${ok} de ${objetivos.length} posts con métricas.`);

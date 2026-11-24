// Análisis de Rule34.
// No publica, no comenta, no vota, no da favoritos. Una sola key (condición de la API), la de la cuenta de marca,
// guardada en el archivo de claves fuera del repo (rule34_api_key, rule34_user_id). Uso interno: sin publicidad ni muro
// de pago (condición de la API). Se corre SIEMPRE a mano (botón del panel); cada corrida reemplaza la anterior y guarda
// sus números principales para mostrar qué cambió.
//   node herramientas/rule34.mjs --analisis [nicho]   arma config/rule34/analisis.json (nicho por defecto: league_of_legends)
//   node herramientas/rule34.mjs --probar             verifica la key con un pedido mínimo
// Qué mide:
//   - el nicho principal, con IA (ai_generated) contra a mano: puntaje (solo suma: Rule34 no tiene votos negativos),
//     comentarios y evolución por mes; los posts de menos de 7 días no cuentan para comparar puntajes;
//   - personajes: demanda (puntaje) contra oferta (cuántos posts con IA hay);
//   - etiquetas que suben o bajan el puntaje de los posts con IA;
//   - franquicias del público de la marca: cuánta IA hay, a qué ritmo se sube y cuánto rinde;
//   - la plataforma: qué parte de lo que se sube hoy es IA;
//   - lo borrado NO se puede medir: la API solo da número y md5 de lo borrado, sin etiquetas (se usa la guía de reglas);
//   - qué premia la gente en los comentarios de los posts con IA más votados;
//   - veredictos: la IA junta todo y dice qué conviene hacer ahora, con la evidencia y el grado de certeza.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cfg, guardar, leer, prohibido, RAIZ } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";

const DIR = join(RAIZ, "config/rule34");
mkdirSync(DIR, { recursive: true });
const RUTA = join(DIR, "analisis.json");
const API = "https://api.rule34.xxx/index.php";
const PAUSA_MS = 1500; // el límite es de pedidos por segundo: se va despacio para no molestar
const DIA = 86400e3;
// Franquicias del público de la marca y Genshin
// como referencia del nicho de IA más grande.
// Prohibidos para la marca (nada que parezca menor, docs/rule34.md): no se recomiendan aunque tengan demanda.
// La lista de personajes prohibidos está en comun.mjs (PROHIBIDOS, prohibido): vale para todas las redes.
const FRANQUICIAS = ["league_of_legends", "arcane", "overwatch", "valorant", "world_of_warcraft", "genshin_impact"];
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

function claves() {
  const k = leer(cfg().publicacion.publicador);
  if (!k.rule34_api_key || !k.rule34_user_id) throw new Error("Falta la key de Rule34: cargala en el panel (pestaña Rule34).");
  return { api_key: k.rule34_api_key, user_id: String(k.rule34_user_id) };
}

let ultimo = 0;
async function api(params, { texto = false, base = API } = {}) {
  const url = `${base}?${new URLSearchParams({ page: "dapi", q: "index", ...params, ...claves() })}`;
  for (let intento = 1; intento <= 4; intento++) {
    const falta = ultimo + PAUSA_MS - Date.now();
    if (falta > 0) await espera(falta);
    ultimo = Date.now();
    try {
      const r = await fetch(url, { headers: { "User-Agent": "nicho-estudio/1.0" } });
      const cuerpo = await r.text();
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      // La API responde 200 con el error en el cuerpo (p. ej. "Missing authentication").
      if (/^"?(Missing authentication|Invalid|search down)/i.test(cuerpo.trim())) throw Object.assign(new Error(cuerpo.trim().replace(/"/g, "")), { fatal: true });
      if (texto) return cuerpo;
      if (!cuerpo.trim()) return [];
      return JSON.parse(cuerpo);
    } catch (e) {
      if (e.fatal || intento === 4) throw e;
      await espera(5000 * intento);
    }
  }
}

/** Posts de una búsqueda (hasta `max`, del más nuevo al más viejo), con el tipo de cada etiqueta. */
async function posts(tags, max, extra = {}, pidInicio = 0) {
  const out = [];
  for (let pid = pidInicio; out.length < max; pid++) {
    const lote = await api({ s: "post", limit: String(Math.min(1000, max - out.length)), pid: String(pid), tags, json: "1", fields: "tag_info", ...extra });
    if (!Array.isArray(lote) || !lote.length) break;
    // El JSON no trae la fecha de subida (solo "change", la última edición): se toma del XML de la misma página.
    const xml = await api({ s: "post", limit: String(Math.min(1000, max - out.length)), pid: String(pid), tags, ...extra }, { texto: true });
    const fechas = new Map([...xml.matchAll(/<post[^>]*>/g)].map((m) => [m[0].match(/id="(d+)"/)?.[1], m[0].match(/created_at="([^"]+)"/)?.[1]]));
    for (const p of lote) p.created_at = fechas.get(String(p.id)) ?? null;
    out.push(...lote);
    console.log(`  ${tags || "(todo)"}: ${out.length}`);
    if (lote.length < 1000) break;
  }
  return out;
}

/** Cantidad total de posts de una búsqueda (la respuesta XML trae count="N"). */
async function cuantos(tags) {
  const xml = await api({ s: "post", limit: "1", tags }, { texto: true });
  return +(xml.match(/<posts[^>]*\bcount="(\d+)"/)?.[1] ?? NaN);
}

const fechaDe = (p) => { const t = Date.parse(p.created_at ?? ""); return Number.isFinite(t) ? t : (+p.change || 0) * 1000; };
const mediana = (l) => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const prom = (l) => (l.length ? +(l.reduce((a, b) => a + b, 0) / l.length).toFixed(1) : null);
const madura = (p) => Date.now() - fechaDe(p) >= 7 * DIA;
const entre7y14 = (p) => { const d = (Date.now() - fechaDe(p)) / DIA; return d >= 7 && d < 14; };
const puntaje = (p) => +p.score || 0;
/** Tipo de cada etiqueta de un post: { tag: tipo } ("character", "copyright", "artist", "general", "metadata"). */
function tipos(p) {
  const m = {};
  for (const t of p.tag_info ?? []) m[t.tag ?? t.name] = t.type;
  return m;
}
const etiquetas = (p) => String(p.tags ?? "").trim().split(/\s+/).filter(Boolean);
const dominio = (s) => { const u = String(s ?? "").trim().split(/\s+/)[0]; if (!u) return "sin source"; try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "otro"; } };
/** Posts por día en una lista ordenada del más nuevo al más viejo. */
const ritmo = (l) => { if (l.length < 2) return null; const t = l.map(fechaDe); const dias = (Math.max(...t) - Math.min(...t)) / DIA; return dias > 0 ? +(l.length / dias).toFixed(1) : null; };

function resumen(lista) {
  const m = lista.filter(madura);
  return { posts: lista.length, puntaje_mediano: mediana(m.map(puntaje)), puntaje_promedio: prom(m.map(puntaje)), comentarios_promedio: prom(m.map((p) => +p.comment_count || 0)), por_dia: ritmo(lista), desde: lista.length ? new Date(Math.min(...lista.map(fechaDe))).toISOString().slice(0, 10) : null };
}

/** Por mes (últimos 6): cuántos posts y puntaje mediano de los maduros. */
function porMes(lista) {
  const m = new Map();
  for (const p of lista) { const k = new Date(fechaDe(p)).toISOString().slice(0, 7); const x = m.get(k) ?? { mes: k, posts: 0, puntajes: [] }; x.posts++; if (madura(p)) x.puntajes.push(puntaje(p)); m.set(k, x); }
  return [...m.values()].sort((a, b) => a.mes.localeCompare(b.mes)).slice(-6).map((x) => ({ mes: x.mes, posts: x.posts, puntaje_mediano: mediana(x.puntajes) }));
}

/** Etiquetas generales con más o menos puntaje que el resto (posts maduros). */
function efectoEtiquetas(lista) {
  const mad = lista.filter(madura);
  const base = mediana(mad.map(puntaje)) ?? 0;
  const conTag = new Map();
  for (const p of mad) { const t = tipos(p); for (const tag of etiquetas(p)) if (["general", "tag"].includes(t[tag] ?? "tag") && tag !== "ai_generated") { const l = conTag.get(tag) ?? []; l.push(puntaje(p)); conTag.set(tag, l); } }
  const minimo = Math.max(10, Math.round(mad.length * 0.02));
  return [...conTag].filter(([, l]) => l.length >= minimo && l.length <= mad.length * 0.9).map(([tag, l]) => ({ etiqueta: tag, posts: l.length, puntaje_mediano: mediana(l), efecto: +((mediana(l) ?? 0) / Math.max(1, base)).toFixed(2) })).sort((a, b) => b.efecto - a.efecto);
}

/** Comentarios de un post (la API de comentarios devuelve XML). */
async function comentarios(id) {
  const xml = await api({ s: "comment", post_id: String(id) }, { texto: true });
  const des = (s) => s.replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return [...xml.matchAll(/<comment\b([^>]*)\/?>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], des(x[2])]))).map((a) => a.body ?? "").filter((t) => t.trim());
}

const correrIA = (prompt) => ejecutarIA(prompt, { herramientas: "Read,Edit,Write", dirs: [DIR] });

async function analisis(nicho) {
  nicho = (nicho || "league_of_legends").trim().toLowerCase().replace(/\s+/g, " ");
  if (!/^[\w:()'.\- ]{2,80}$/.test(nicho)) throw new Error("Nicho inválido: usá etiquetas de Rule34, p. ej. league_of_legends");
  const anterior = existsSync(RUTA) ? leer(RUTA) : null;
  const avisos = [];
  console.log(`== 1/5 Nicho principal: "${nicho}"`);
  const ia = await posts(`${nicho} ai_generated`, 3000);
  const mano = await posts(`${nicho} -ai_generated`, 3000);
  const iaMad = ia.filter(madura);
  const medIA = mediana(iaMad.map(puntaje)) ?? 0;

  // Personajes: demanda (puntaje de los posts con IA) contra oferta (cuántos posts con IA hay) y cuánto hay a mano.
  const porPj = new Map();
  for (const [lista, campo] of [[ia, "ia"], [mano, "mano"]]) for (const p of lista) { const t = tipos(p); for (const tag of etiquetas(p)) if (t[tag] === "character") { const x = porPj.get(tag) ?? { personaje: tag, ia: [], mano: 0, ia_total: 0 }; if (campo === "ia") { x.ia_total++; if (madura(p)) x.ia.push(puntaje(p)); } else x.mano++; porPj.set(tag, x); } }
  if (!porPj.size) avisos.push("La API no devolvió el tipo de etiqueta (personaje): la tabla de personajes queda vacía.");
  const personajes = [...porPj.values()].filter((x) => x.ia_total + x.mano >= 5 && !prohibido(x.personaje)).map((x) => {
    const med = mediana(x.ia);
    // Oportunidad: puntaje mediano con IA por encima del general del nicho y poca oferta con IA frente a lo que hay a mano.
    const oportunidad = med != null && x.ia.length >= 3 ? +((med / Math.max(1, medIA)) * Math.log10(10 + x.mano) / Math.log10(10 + x.ia_total)).toFixed(2) : null;
    return { personaje: x.personaje, posts_ia: x.ia_total, posts_mano: x.mano, puntaje_mediano_ia: med, oportunidad };
  }).sort((a, b) => (b.oportunidad ?? -1) - (a.oportunidad ?? -1));
  const tagsLift = efectoEtiquetas(ia);

  // Sugerente contra explícito: con los mismos posts con IA del nicho, por rating. El puntaje se
  // compara con posts de 7 a 14 días (sigue subiendo con el tiempo); si hay pocos, con todos los de 7 días o más.
  const grupoTono = (l) => {
    const v = l.filter(entre7y14), base = v.length >= 30 ? v : l.filter(madura);
    return { posts: l.length, pct: ia.length ? +(l.length / ia.length * 100).toFixed(1) : null, por_dia: ritmo(l), puntaje_mediano: mediana(base.map(puntaje)), comentarios_promedio: prom(base.map((p) => +p.comment_count || 0)), muestra: base.length, ventana: v.length >= 30 ? "7 a 14 días" : "7 días o más" };
  };
  const conRating = ia.filter((p) => p.rating);
  if (ia.length && !conRating.length) avisos.push("La API no devolvió el rating de los posts: no se pudo comparar sugerente contra explícito.");
  const sug = conRating.filter((p) => p.rating === "questionable"), exp = conRating.filter((p) => p.rating === "explicit");
  // Dentro de cada tono, qué tipo de pieza rinde más (etiquetas de lo que se ve).
  const SUB_SUG = ["lingerie", "bikini", "swimsuit", "underwear", "from_below", "cleavage", "thighhighs", "leotard", "bodysuit", "skin_tight", "ass_focus", "looking_at_viewer", "text"];
  const SUB_EXP = ["nude", "completely_nude", "topless", "solo", "1boy", "sex", "pussy", "nipples", "spread_legs", "ass_focus", "text"];
  const subtipos = (l, tags) => tags.map((t) => { const c = l.filter((p) => etiquetas(p).includes(t)); const b = c.filter(madura); return { etiqueta: t, posts: c.length, puntaje_mediano: mediana(b.map(puntaje)), muestra: b.length }; }).filter((x) => x.muestra >= 10).sort((a, b) => (b.puntaje_mediano ?? 0) - (a.puntaje_mediano ?? 0));
  const tono = conRating.length ? {
    sugerente: { ...grupoTono(sug), subtipos: subtipos(sug, SUB_SUG) },
    explicito: { ...grupoTono(exp), subtipos: subtipos(exp, SUB_EXP) },
    // personajes: ¿dónde rinde más cada uno? (solo los que tienen al menos 5 maduros en cada tono)
    personajes: [...new Set(conRating.flatMap((p) => etiquetas(p).filter((t) => tipos(p)[t] === "character")))].map((pj) => {
      const s2 = sug.filter((p) => etiquetas(p).includes(pj) && madura(p)), e2 = exp.filter((p) => etiquetas(p).includes(pj) && madura(p));
      return { personaje: pj, sugerente: mediana(s2.map(puntaje)), explicito: mediana(e2.map(puntaje)), n_sugerente: s2.length, n_explicito: e2.length };
    }).filter((x) => x.n_sugerente >= 5 && x.n_explicito >= 5 && !prohibido(x.personaje)).sort((a, b) => (b.n_sugerente + b.n_explicito) - (a.n_sugerente + a.n_explicito)).slice(0, 12),
  } : null;

  // Quienes suben IA (muchos son reposteros) y adónde apunta su source.
  const porDueño = new Map();
  for (const p of ia) { const x = porDueño.get(p.owner) ?? { usuario: p.owner, posts: 0, puntajes: [], sources: {} }; x.posts++; if (madura(p)) x.puntajes.push(puntaje(p)); const d = dominio(p.source); x.sources[d] = (x.sources[d] ?? 0) + 1; porDueño.set(p.owner, x); }
  const artistas = [...porDueño.values()].filter((x) => x.posts >= 5 && x.puntajes.length >= 3).map((x) => ({ usuario: x.usuario, posts: x.posts, puntaje_mediano: mediana(x.puntajes), source_principal: Object.entries(x.sources).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d, n]) => `${d} (${n})`).join(", ") })).sort((a, b) => b.puntaje_mediano - a.puntaje_mediano).slice(0, 12);
  const sources = {};
  for (const p of ia) { const d = dominio(p.source); sources[d] = (sources[d] ?? 0) + 1; }

  console.log("== 2/5 Franquicias del público");
  const franquicias = [];
  for (const f of FRANQUICIAS) {
    try {
      const total = await cuantos(f), conIA = await cuantos(`${f} ai_generated`);
      const ult = f === nicho ? ia.slice(0, 1000) : await posts(`${f} ai_generated`, 1000);
      const pd = ritmo(ult);
      // Para comparar franquicias con la misma vara: puntaje de los posts con IA de 7 a 14 días (el puntaje sigue
      // subiendo con el tiempo). En las que suben mucho, esos posts están más atrás en la lista: se saltan páginas.
      let ventana = (f === nicho ? ia : ult).filter(entre7y14);
      if (ventana.length < 100 && pd) ventana = (await posts(`${f} ai_generated`, 2000, {}, Math.floor(pd * 7 / 1000))).filter(entre7y14);
      franquicias.push({ franquicia: f, posts: total, posts_ia: conIA, ia_pct: total ? +(conIA / total * 100).toFixed(1) : null, ia_por_dia: pd, puntaje_mediano_ia: mediana(ventana.map(puntaje)), muestra: ventana.length });
    } catch (e) { avisos.push(`Franquicia ${f}: ${e.message}`); }
  }

  console.log("== 3/5 La plataforma");
  let plataforma = null;
  try {
    const todo = await cuantos(""), todoIA = await cuantos("ai_generated");
    const recientes = await posts("", 1000);
    const recIA = recientes.filter((p) => etiquetas(p).includes("ai_generated")).length;
    plataforma = { posts: todo, posts_ia: todoIA, ia_pct_total: todo ? +(todoIA / todo * 100).toFixed(1) : null, ia_pct_ultimos_1000: recientes.length ? +(recIA / recientes.length * 100).toFixed(1) : null, por_dia: ritmo(recientes), nicho_por_mes_ia: porMes(ia), nicho_por_mes_mano: porMes(mano) };
  } catch (e) { avisos.push(`Plataforma: ${e.message}`); }

  // Lo borrado: la API solo da el número y la huella (md5) de cada post borrado, sin etiquetas ni fecha (probado el
  // 2026-11-19), así que no se puede medir qué se borra. Los veredictos usan las reglas del sitio (docs/rule34.md).
  const borrados = null;

  console.log("== 4/5 Comentarios de los posts con IA más votados");
  const top = [...iaMad].filter((p) => +p.comment_count > 0).sort((a, b) => puntaje(b) - puntaje(a)).slice(0, 30);
  const conComs = [];
  for (const p of top) {
    try { const coms = (await comentarios(p.id)).slice(0, 15).map((c) => c.slice(0, 400)); if (coms.length) conComs.push({ id: p.id, puntaje: puntaje(p), etiquetas: etiquetas(p).slice(0, 40), comentarios: coms }); }
    catch (e) { avisos.push(`Comentarios ${p.id}: ${e.message}`); break; }
  }

  const datos = {
    nicho, creado: new Date().toISOString(),
    ia: resumen(ia), mano: resumen(mano),
    personajes: personajes.slice(0, 40),
    etiquetas_suben: tagsLift.slice(0, 25),
    etiquetas_bajan: tagsLift.slice(-15).reverse(),
    artistas_ia: artistas,
    sources_ia: Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, n]) => ({ dominio: d, posts: n })),
    franquicias, plataforma, borrados, tono,
    top_ia: [...iaMad].sort((a, b) => puntaje(b) - puntaje(a)).slice(0, 12).map((p) => ({ id: p.id, puntaje: puntaje(p), comentarios: +p.comment_count || 0, link: `https://rule34.xxx/index.php?page=post&s=view&id=${p.id}`, personajes: etiquetas(p).filter((t) => tipos(p)[t] === "character") })),
    avisos,
    anterior: anterior ? { creado: anterior.creado, ia: anterior.ia, mano: anterior.mano, franquicias: anterior.franquicias, plataforma: anterior.plataforma && { ia_pct_ultimos_1000: anterior.plataforma.ia_pct_ultimos_1000 }, tono: anterior.tono && { sugerente: { puntaje_mediano: anterior.tono.sugerente.puntaje_mediano, pct: anterior.tono.sugerente.pct }, explicito: { puntaje_mediano: anterior.tono.explicito.puntaje_mediano, pct: anterior.tono.explicito.pct } } } : null,
  };

  console.log("== 5/5 Veredictos");
  const tmp = join(DIR, "veredictos-tanda.json");
  guardar(tmp, { datos, posts_con_comentarios: conComs, comentarios: null, veredictos: null, resumen: null });
  await correrIA([
    `En ${tmp} está el análisis de Rule34 ("datos") para la marca: ilustraciones de anime hechas con IA, sobre todo de League of Legends, con Patreon. Leé también ${join(RAIZ, "docs/rule34.md")} (reglas del sitio).`,
    `1) "comentarios": con "posts_con_comentarios" (en inglés) completá {"posts_leidos", "comentarios_leidos", "positivos_pct", "neutros_pct", "negativos_pct", "elogios": [hasta 8 {"tema" en español, "veces", "ejemplo" tal cual y corto}], "quejas": [hasta 5 igual], "pedidos": [hasta 5 {"tema", "veces"}]}. Contá solo lo que dicen.`,
    `2) "veredictos": entre 6 y 10 {"tipo": "hacer" | "evitar" | "vigilar", "titulo": en español, corto y accionable (p. ej. "Priorizá Evelynn y Katarina"), "por_que": la evidencia con números del análisis, "certeza": "alta" | "media" | "baja" (según cuántos datos lo respaldan)}. Cubrí: si conviene subir sugerente (rating questionable, sin desnudos: es lo que la marca puede enlazar a su pack gratis de Patreon) o explícito, con los números de "tono" (puntaje, oferta y qué tipo de pieza sugerente rinde más), qué personajes y franquicias conviene hacer ahora, qué prefieren los usuarios (etiquetas y comentarios), qué se borra y cómo evitarlo (la API no dice qué se borra: usá las reglas de docs/rule34.md y las quejas de los comentarios), hacia dónde va la plataforma con la IA y, si hay "anterior", qué cambió.`,
    `3) "resumen": en español, 2 o 3 frases con la conclusión general (¿vale la pena Rule34 para la marca y por dónde arrancar?).`,
    `No inventes datos: si algo no tiene datos suficientes, decilo con certeza "baja". Respetá las reglas del sitio (nada de marca de agua en IA, nada que parezca menor, nada de estilos de artistas). No toques otros archivos.`,
  ].join(" "));
  const r = leer(tmp);
  rmSync(tmp, { force: true });
  guardar(RUTA, { ...datos, comentarios: r.comentarios ?? { posts_leidos: conComs.length }, veredictos: r.veredictos ?? [], resumen: r.resumen ?? null });
  console.log(`LISTO: ${ia.length} posts con IA y ${mano.length} a mano; ${personajes.length} personajes; ${franquicias.length} franquicias; ${(r.veredictos ?? []).length} veredictos.${avisos.length ? ` Avisos: ${avisos.join(" | ")}` : ""}`);
}

try {
  const [modo, a1] = process.argv.slice(2);
  if (modo === "--probar") { const r = await api({ s: "post", limit: "1", json: "1" }); console.log(Array.isArray(r) && r.length ? `Key OK (post ${r[0].id}).` : "La API respondió vacío."); }
  else if (modo === "--analisis") await analisis(a1);
  else console.log("Uso: --probar | --analisis [nicho]");
} catch (e) { console.error(e.message); process.exitCode = 1; }

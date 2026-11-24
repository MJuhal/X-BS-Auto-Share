// Panel local de la marca en X y Bluesky: ver y aprobar lotes, editar textos, bloquear piezas,
// generar un lote, programar en las dos redes y activar o pausar la automatización.
// El contenido es uno solo (se piensa para X y se replica en Bluesky); el panel muestra el estado,
// las métricas y los links de la red elegida.
//   node herramientas/panel/servidor.mjs [--puerto 4391]   (o doble clic en Abrir-panel.vbs)
// Escucha solo en 127.0.0.1. Se cierra con "Cerrar panel" o solo, después de 4 horas sin uso.
import { createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, normalize } from "node:path";
import { asignarFechas, franjasDe, sumarDias, backlogListo, carpetas, carpetasLote, cfg, CONFIG, controlar, estadoDe, guardar, hoyEn, huellaLote, idPieza, instante, leer, pendientes, personajeDe, postsPorFranja, seguidos, lotes, pesoBsky, pesoX, pNN, publicables, RAIZ, redes, redesLote, textoFinal, textoBsky, textoX, PROHIBIDOS } from "../comun.mjs";
import { accionesAsistente } from "./asistente.mjs";
import { configurado } from "../comun.mjs";
import { anotar } from "../bsky-registro.mjs";
import { analizarLink, CONDICIONES, DIR_SORTEOS, rutaSorteo } from "../sorteo.mjs";
import { hayCredenciales, sesion as sesionX } from "../x-api.mjs";
import { aprobadoPixiv, asignarFechasPixiv, confPixiv, controlarPixiv, estadoPixiv, etiquetasDe, franjasPixiv, horasPixivEn, manualPixiv, huellaPixiv, lotesPixiv, publicablesPixiv, stockPixiv, POR_POST, personajesPatreon } from "../pixiv-comun.mjs";

const PUERTO = Number(process.argv[process.argv.indexOf("--puerto") + 1]) || 4392;
const PUBLICO = join(import.meta.dirname, "public");
const TAREA = "X-BS-Auto-Automatizacion";
const LOG = join(RAIZ, "config/trabajo.log");
const CLAVES = ["x", "bsky"];
const enRedes = (e, fn) => CLAVES.some((k) => e[k] && fn(e[k]));
let ultimoUso = Date.now();
setInterval(() => Date.now() - ultimoUso > 4 * 3600e3 && process.exit(0), 60e3).unref();

// Trabajos en paralelo: solo esperan los que comparten algo. Un trabajo por grupo:
//   lotes         lotes de X y Bluesky (generar, revisar, programar, métricas: tocan los mismos archivos)
//   pixiv-chrome  todo lo que abre el Chrome de Pixiv (sugerencias, concursos, subir, publicar, sesión)
//   pixiv-lotes   armar lotes de Pixiv
//   bsky, xr, xt, sorteos, reddit, rule34   cada asistente con lo suyo (xt: traductor con la voz de la marca)
const trabajos = new Map(); // grupo → { tipo, inicio, proceso, log }
let ultimoLog = LOG;
const ocupado = (g) => trabajos.get(g);
function lanzar(tipo, args, grupo) {
  if (!grupo) throw new Error("Falta el grupo del trabajo.");
  const t = trabajos.get(grupo);
  if (t) throw new Error(`Esperá que termine: ${t.tipo}`);
  const log = join(RAIZ, `config/trabajo-${grupo}.log`);
  const fd = openSync(log, "w");
  const p = spawn("node", args, { cwd: RAIZ, stdio: ["ignore", fd, fd] });
  trabajos.set(grupo, { tipo, inicio: new Date().toISOString(), proceso: p, log });
  ultimoLog = log;
  p.on("close", (code) => {
    writeFileSync(log, readFileSync(log, "utf8") + `\n[fin: código ${code}]\n`);
    trabajos.delete(grupo);
  });
}
const listaTrabajos = () => [...trabajos.entries()].map(([grupo, t]) => ({ grupo, tipo: t.tipo, inicio: t.inicio })).sort((a, b) => b.inicio.localeCompare(a.inicio));

const ps = (cmd) => new Promise((ok) => {
  const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd]);
  let s = "";
  p.stdout.on("data", (d) => (s += d));
  p.on("close", (code) => ok({ code, s: s.trim() }));
  p.on("error", () => ok({ code: -1, s: "" }));
});

// La publicación la hace Buffer en sus servidores, con o sin panel. Esto solo trae el resultado:
// si hay un post con la hora cumplida, le pregunta a Buffer (como máximo una vez por minuto).
let ultimaConsulta = 0, consultando = false;
function traerPublicados() {
  const vencido = lotes().some((d) => Object.values(estadoDe(d).piezas).some((e) => enRedes(e, (r) => r.estado === "PROGRAMADO" && Date.parse(r.dueAt) <= Date.now())));
  if (!vencido || consultando || Date.now() - ultimaConsulta < 60e3) return;
  ultimaConsulta = Date.now();
  consultando = true;
  const p = spawn("node", ["herramientas/publicar.mjs", "--estado"], { cwd: RAIZ, stdio: "ignore", env: process.env });
  p.on("close", () => (consultando = false));
  p.on("error", () => (consultando = false));
}

// Métricas: si hay posts publicados con métricas de hace más de 6 horas, las pide a Buffer
// (como máximo una vez cada 10 minutos mientras el panel está abierto).
let ultimaMetrica = 0, midiendo = false;
function traerMetricas() {
  const viejas = lotes().some((d) => Object.values(estadoDe(d).piezas).some((e) => enRedes(e, (r) => r.estado === "PUBLICADO"
    && Date.now() - Date.parse(r.enviado) < 30 * 86400e3
    && (!r.metricas_consultadas || Date.now() - Date.parse(r.metricas_consultadas) > 6 * 3600e3))));
  if (!viejas || midiendo || consultando || Date.now() - ultimaMetrica < 10 * 60e3) return;
  ultimaMetrica = Date.now();
  midiendo = true;
  const p = spawn("node", ["herramientas/publicar.mjs", "--metricas"], { cwd: RAIZ, stdio: "ignore", env: process.env });
  p.on("close", () => (midiendo = false));
  p.on("error", () => (midiendo = false));
}

/** Resumen de rendimiento: totales, por horario, por tipo de cierre y mejores posts.
 *  Los promedios usan solo posts con 48 h o más (las métricas ya se asentaron). */
function rendimiento(todos, k = "x") {
  const posts = todos.flatMap(({ l, est }) => l.piezas.filter((p) => est[p.n]?.[k]?.metricas).map((p) => {
    const x = est[p.n][k], m = x.metricas;
    const vistas = m.impressions ?? m.views ?? m.reach ?? null;
    const interacciones = (m.likes ?? m.reactions ?? 0) + (m.reposts ?? m.shares ?? 0) + (m.comments ?? 0) + (m.quotes ?? 0);
    const eng = m.engagementRate ?? (vistas ? (100 * interacciones) / vistas : null);
    return { id: idPieza(l.lote, p.n), lote: l.lote, n: p.n, texto: p.texto, hora: p.hora, cta: p.cta, enviado: x.enviado, link: x.link, img: `/img/${l.lote}/${pNN(p.n)}`, m, vistas, interacciones, eng, clicks: m.clicks ?? null };
  }));
  const maduros = posts.filter((p) => Date.now() - Date.parse(p.enviado) >= 48 * 3600e3);
  const prom = (xs) => { const v = xs.filter((x) => typeof x === "number"); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const agrupar = (clave) => Object.entries(Object.groupBy(maduros, (p) => p[clave] ?? "?")).map(([k, ps]) => ({
    clave: k, posts: ps.length, vistas: prom(ps.map((p) => p.vistas)), eng: prom(ps.map((p) => p.eng)), clicks: prom(ps.map((p) => p.clicks)), interacciones: prom(ps.map((p) => p.interacciones)),
  })).sort((a, b) => (b.vistas ?? 0) - (a.vistas ?? 0));
  const suma = (k) => posts.reduce((a, p) => a + (p[k] ?? 0), 0);
  // Hashtags: cómo rinden nuestros posts según el hashtag que llevan (un post con 2 cuenta en
  // los 2), comparado con los que no llevan ninguno. Incluye los de la lista del nicho aunque todavía no se usaron.
  const tagsDe = (p) => [...new Set((p.texto?.match(/#\w+/g) ?? []).map((t) => t.toLowerCase()))];
  const grupos = new Map((cfg().hashtags?.lista ?? []).map((t) => [t.toLowerCase(), []]));
  for (const p of maduros) { const ts = tagsDe(p); for (const t of ts.length ? ts : ["sin hashtag"]) { if (!grupos.has(t)) grupos.set(t, []); grupos.get(t).push(p); } }
  const porHashtag = [...grupos].map(([clave, ps]) => ({ clave, posts: ps.length, vistas: prom(ps.map((p) => p.vistas)), eng: prom(ps.map((p) => p.eng)), clicks: prom(ps.map((p) => p.clicks)), interacciones: prom(ps.map((p) => p.interacciones)) }))
    .sort((a, b) => (b.vistas ?? -1) - (a.vistas ?? -1) || b.posts - a.posts);
  const usos = new Map();
  for (const p of posts) for (const t of tagsDe(p)) usos.set(t, (usos.get(t) ?? 0) + 1);
  return {
    por_hashtag: porHashtag,
    usos_hashtag: Object.fromEntries(usos),
    posts: posts.length,
    maduros: maduros.length,
    disponibles: [...new Set(posts.flatMap((p) => Object.keys(p.m)))],
    totales: { vistas: suma("vistas"), interacciones: suma("interacciones"), clicks: suma("clicks"), eng: prom(posts.map((p) => p.eng)) },
    por_hora: agrupar("hora"),
    por_cta: agrupar("cta"),
    mejores: [...posts].sort((a, b) => (b.vistas ?? b.interacciones) - (a.vistas ?? a.interacciones)).slice(0, 3),
  };
}

/** Instante (ms) en que sale una pieza en una red (con su desfase). */
const instanteRed = (p, red) => instante(p.fecha, p.hora, p.zona).getTime() + (red.desfase_min ?? 0) * 60e3;

function dirLote(nombre) {
  const dir = lotes().find((d) => d.endsWith(nombre) && leer(join(d, "lote.json")).lote === nombre);
  if (!dir) throw new Error(`No existe el lote ${nombre}`);
  return dir;
}

async function estado() {
  const c = cfg();
  const dirs = carpetas(c);
  const tarea = await ps(`(Get-ScheduledTask -TaskName '${TAREA}' -ErrorAction SilentlyContinue).State`);
  const hoy = hoyEn(c.publicacion.zona);
  traerPublicados();
  traerMetricas();
  const todos = lotes(c).map((dir) => ({ dir, l: leer(join(dir, "lote.json")), est: estadoDe(dir).piezas, aprobado: existsSync(join(dir, "aprobacion.json")) && leer(join(dir, "aprobacion.json")).huella === huellaLote(dir) }));
  const listaRedes = redes(c);
  // Lo que depende de la red: publicados, por salir, próximo, problemas, último link y rendimiento.
  const porRed = Object.fromEntries(listaRedes.map((red) => {
    const k = red.clave;
    const desde = red.desde ? Date.parse(red.desde) : 0;
    const piezas = todos.filter(({ l }) => redesLote(l).includes(k)).flatMap(({ l, est, aprobado }) => publicables(l).map((p) => ({ ...p, r: est[p.n]?.[k] ?? null, aprobado })))
      // Bluesky arrancó después: lo que salía antes de activarlo no cuenta para esa red.
      .filter((p) => !desde || !p.fecha || p.r || instanteRed(p, red) >= desde);
    // CANCELADO (2026-11-23): sacado de Buffer a pedido de la persona a cargo; no cuenta como por salir ni como problema.
    const porSalir = piezas.filter((p) => p.aprobado && p.fecha && p.r?.estado !== "PUBLICADO" && !["VENCIDO", "FALLIDO", "BLOQUEADO", "CANCELADO"].includes(p.r?.estado)).sort((a, b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`));
    return [k, {
      kpis: {
        publicados: piezas.filter((p) => p.r?.estado === "PUBLICADO").length,
        por_salir: porSalir.length,
        programados: porSalir.filter((p) => p.r?.estado === "PROGRAMADO").length,
        cubierto_hasta: porSalir.at(-1)?.fecha ?? null,
        proximo: porSalir[0] ? { fecha: porSalir[0].fecha, hora: porSalir[0].hora, texto: porSalir[0].texto } : null,
        // Solo los que todavía importan: un fallo cuya hora ya pasó no se reintenta (publicar.mjs no publica tarde) (2026-11-23: los de cuando
        // X estuvo bloqueada quedaban como alerta para siempre). Siguen visibles en su tarjeta.
        con_problema: piezas.filter((p) => ["VENCIDO", "FALLIDO", "BLOQUEADO"].includes(p.r?.estado) && (!p.fecha || instanteRed(p, red) > Date.now())).length,
        // aprobados que todavía no están en Buffer (esperan lugar en la cola de 10): es lo normal, entran solos.
        // Solo es un problema si sale en menos de 24 horas y no entró.
        en_espera: porSalir.filter((p) => p.r?.estado !== "PROGRAMADO").length,
        en_espera_pronto: porSalir.filter((p) => p.r?.estado !== "PROGRAMADO" && instante(p.fecha, p.hora, p.zona).getTime() < Date.now() + 24 * 3600e3).map((p) => ({ fecha: p.fecha, hora: p.hora })),
        ultimo_link: piezas.filter((p) => p.r?.link).sort((a, b) => (b.r.enviado ?? "").localeCompare(a.r.enviado ?? ""))[0]?.r.link ?? null,
      },
      rendimiento: rendimiento(todos, k),
      // Seguimiento: todo lo publicado en esta red, del más nuevo al más viejo.
      publicados: todos.flatMap(({ l, est }) => l.piezas.filter((p) => est[p.n]?.[k]?.estado === "PUBLICADO").map((p) => ({
        id: idPieza(l.lote, p.n), lote: l.lote, fecha: p.fecha, hora: p.hora, personaje: p.personaje ?? "", texto: p.texto, cta: p.cta,
        enviado: est[p.n][k].enviado ?? null, link: est[p.n][k].link ?? null, metricas: est[p.n][k].metricas ?? null, img: `/img/${l.lote}/${pNN(p.n)}`,
      }))).sort((a, b) => `${b.fecha} ${b.hora}`.localeCompare(`${a.fecha} ${a.hora}`)),
    }];
  }));
  // Franjas de hoy y de mañana (hora de publicación) que todavía llegan y no tienen un post aprobado.
  const ocupadas = postsPorFranja(c);
  // Una franja con un post a menos de `separacion_min` (fuera de la agenda, p. ej. horas de una agenda vieja) cuenta como
  // cubierta: no es un hueco real. Para dejar todo en la agenda actual: node herramientas/reprogramar.mjs.
  const sepMs = (c.publicacion.separacion_min ?? 180) * 60e3;
  const instOcup = [...ocupadas.keys()].map((k) => instante(...k.split(" "), c.publicacion.zona).getTime());
  const franjasVacias = [hoy, sumarDias(hoy, 1)].flatMap((dia) => franjasDe(dia, c).filter((h) => { const t = instante(dia, h, c.publicacion.zona).getTime(); return t > Date.now() && !instOcup.some((x) => Math.abs(x - t) < sepMs); }).map((h) => ({ fecha: dia, hora: h })));
  const kpis = {
    franjas_vacias: franjasVacias,
    backlog_listo: backlogListo(c).length,
    // Regla: nunca dos días seguidos el mismo personaje. Fechas aprobadas (de hoy en adelante) que lo repiten.
    repetidos: seguidos([...postsPorFranja(c)].map(([k, personaje]) => { const [fecha, hora] = k.split(" "); return { fecha, hora, personaje }; })).filter((x) => x.fecha >= hoy)
      .filter((x) => !todos.some(({ l }) => l.permitir_repetir && redesLote(l).includes("x") && publicables(l).some((p) => p.fecha === x.fecha && p.hora === x.hora))),
    sin_aprobar: todos.filter((x) => !x.aprobado && publicables(x.l).length && !Object.values(x.est).some((e) => enRedes(e, (r) => r.estado))).length,
  };
  return {
    kpis,
    redes: listaRedes.map((r) => ({ clave: r.clave, nombre: r.nombre, limite: r.limite, desfase_min: r.desfase_min, desde: r.desde })),
    por_red: porRed,
    midiendo,
    marca: c.marca,
    zona: c.publicacion.zona,
    horas: c.publicacion.horas,
    agenda: ([...(c.publicacion.cambios_agenda ?? [])].sort((a, b) => a.desde.localeCompare(b.desde)).filter((x) => x.desde <= hoyEn(c.publicacion.zona)).at(-1)?.agenda ?? c.publicacion.agenda) ?? null,
    automatizacion: { ...c.automatizacion, tarea: tarea.s || null },
    carpetas: { lote: carpetasLote(c).reduce((a, d) => a + pendientes(d, c).length, 0), backlog: pendientes(dirs.backlog, c).length, ruta: dirs.nuevas },
    trabajos: listaTrabajos(),
    trabajo: listaTrabajos()[0] ?? null, // el más reciente (el detalle de Último trabajo es el suyo)
    reddit: redditPanel(),
    rule34: rule34Panel(),
    bsky_inter: bskyPanel(),
    x_respuestas: xRespuestasPanel(),
    x_traducciones: existsSync(RUTA_XT) ? leer(RUTA_XT).traducciones.slice(0, 8) : [],
    sorteos: sorteosPanel(),
    x_excluir: xExcluir(),
    personajes_marca: [...personajesPatreon(c)], // los de los packs de Patreon (banco): pedidos de X
    prohibidos: [...PROHIBIDOS], // personajes que la marca no hace (comun.mjs)
    log: existsSync(ultimoLog) ? readFileSync(ultimoLog, "utf8").split("\n").slice(-25).join("\n") : "",
    pixiv: estadoPixivPanel(c),
    lotes: lotes(c).reverse().map((dir) => {
      const l = leer(join(dir, "lote.json"));
      const est = estadoDe(dir).piezas;
      const aprob = existsSync(join(dir, "aprobacion.json")) ? leer(join(dir, "aprobacion.json")) : null;
      return {
        lote: l.lote,
        tipo: l.tipo ?? "lote",
        redes: redesLote(l), // 2026-11-23: cada lote puede salir solo en X o solo en Bluesky
        contexto: l.contexto ?? null,
        revisado: l.revisado ?? null,
        aprobado: aprob ? { fecha: aprob.fecha, vigente: aprob.huella === huellaLote(dir) } : null,
        piezas: l.piezas.map((p) => ({
          n: p.n, id: idPieza(l.lote, p.n), cta: p.cta, personaje: p.personaje ?? "", texto: p.texto, alt: p.alt, idea: p.idea,
          fecha: p.fecha, hora: p.hora, bloqueada: !!p.bloqueada, motivo: p.motivo ?? null,
          revision: p.revision ?? null, origen: p.origen,
          problemas: p.bloqueada ? [] : controlar(p, c, { lote: l.lote }),
          peso: p.texto ? pesoX(textoX(p.texto, c, p.personaje)) : 0,
          peso_bsky: p.texto ? pesoBsky(textoBsky(p.texto, c, p.personaje)) : 0,
          final: p.texto ? textoX(p.texto, c, p.personaje) : "",
          x: est[p.n]?.x ?? null,
          bsky: est[p.n]?.bsky ?? null,
          // redes que se sumaron después de que este post ya tenía su hora: no se replica ahí
          antes: Object.fromEntries(redes(c).filter((r) => r.desde && p.fecha).map((r) => [r.clave, instanteRed(p, r) < Date.parse(r.desde)])),
          pasada: p.fecha ? p.fecha < hoy : false,
          img: `/img/${l.lote}/${pNN(p.n)}`,
        })),
        // permitir_repetir (2026-11-23, Akali Week): el lote es de un solo personaje a propósito; no se avisa.
        seguidos: l.permitir_repetir ? [] : seguidos(publicables(l).map((p) => ({ fecha: p.fecha, hora: p.hora, personaje: personajeDe(p) }))),
        sin_personaje: publicables(l).filter((p) => !p.personaje).length,
      };
    }),
  };
}

/** Asistente de interacción de Pixiv: las sugerencias del último día (config/interaccion/<fecha>.json). */
const DIR_INTER = join(RAIZ, "config/interaccion");
// Búsqueda automática (al abrir el panel con todo resuelto): como mucho una cada 2 horas, aunque falle.
const RUTA_INTENTO = join(DIR_INTER, "ultimo-intento.json");
const ultimoIntentoInter = () => existsSync(RUTA_INTENTO) ? leer(RUTA_INTENTO).cuando : null;
// Concursos oficiales (pixiv-concursos.mjs): se actualizan con el botón o solos al abrir el panel cada 12 horas.
const RUTA_CONC = join(DIR_INTER, "concursos.json");
// Métricas de Pixiv (pixiv-metricas.mjs): con el botón o solas al abrir el panel cada 6 horas.
const RUTA_PX_MET = join(RAIZ, "config/pixiv-metricas.json");
const RUTA_CONC_INTENTO = join(DIR_INTER, "concursos-intento.json");
function concursosPanel() {
  const d = existsSync(RUTA_CONC) ? leer(RUTA_CONC) : null;
  const intento = existsSync(RUTA_CONC_INTENTO) ? leer(RUTA_CONC_INTENTO).cuando : null;
  return { actualizado: d?.actualizado ?? null, intento, concursos: d?.concursos ?? [] };
}
// Bluesky: sugerencias de interacción (bsky-sugerencias.mjs). Búsqueda sola al abrir el panel, máximo cada 2 h.
const DIR_BS = join(RAIZ, "config/bsky");
const RUTA_BS_INTENTO = join(DIR_BS, "ultimo-intento.json");
function bskyPanel() {
  const intento = existsSync(RUTA_BS_INTENTO) ? leer(RUTA_BS_INTENTO).cuando : null;
  if (!existsSync(DIR_BS)) return { intento, posts: [], cuentas: [] };
  const f = readdirSync(DIR_BS).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().at(-1);
  if (!f) return { intento, posts: [], cuentas: [] };
  const d = leer(join(DIR_BS, f));
  return { fecha: d.fecha, generado: d.generado, nuevas: d.nuevas ?? null, intento, posts: d.posts.map(({ mini, ...p }) => ({ ...p, mini: `/imgb/${basename(dirname(mini))}/${basename(mini, ".jpg")}` })), cuentas: d.cuentas.filter((c) => c.estado !== "descartada") };
}
// X: respuestas sugeridas a partir de lo que la persona a cargo pega (x-respuestas.mjs).
const RUTA_XR = join(RAIZ, "config/x-respuestas.json");
// X: traductor con la voz de la marca (x-traducir.mjs, la persona a cargo 2026-11-20).
const RUTA_XT = join(RAIZ, "config/x-traducciones.json");
// Sorteos: uno por archivo en config/sorteos; los anulados quedan como .anulado.
function sorteosPanel() {
  const lista = existsSync(DIR_SORTEOS) ? readdirSync(DIR_SORTEOS).filter((f) => f.endsWith(".json")).map((f) => leer(join(DIR_SORTEOS, f))) : [];
  const ses = sesionX();
  return { lista: lista.sort((a, b) => b.creado.localeCompare(a.creado)), x: { credenciales: hayCredenciales(), cuenta: ses?.cuenta ?? null } };
}
const sorteoDe = (id) => { if (!/^[a-z0-9-]+$/.test(id ?? "") || !existsSync(rutaSorteo(id))) throw new Error("No encontré el sorteo."); return leer(rutaSorteo(id)); };
const xRespuestasPanel = () => (existsSync(RUTA_XR) ? leer(RUTA_XR).tandas.slice(0, 5).map((t) => ({ ...t, posts: t.posts.map(({ mini, ...p }) => ({ ...p, mini: mini ? `/imgx/${basename(mini, ".jpg")}` : null })) })) : []);
// Lo que Grok ya pasó (últimos 30 días): va en el pedido como lista de exclusión.
const RUTA_XV = join(RAIZ, "config/x-vistos.json");
function xExcluir() {
  if (!existsSync(RUTA_XV)) return { cuentas: [], links: [] };
  const v = leer(RUTA_XV).posts.filter((p) => Date.now() - Date.parse(p.fecha) < 30 * 86400e3).reverse();
  return { cuentas: [...new Set(v.map((p) => p.cuenta).filter(Boolean))].slice(0, 60), links: v.map((p) => p.link).slice(0, 40) };
}

// Reddit (asistente; la persona a cargo publica y comenta a mano): subreddits, posts preparados y comentarios sugeridos.
const DIR_RD = join(RAIZ, "config/reddit");
function redditPanel() {
  const c = (f, def) => (existsSync(join(DIR_RD, f)) ? leer(join(DIR_RD, f)) : def);
  const ORDEN = { sirve: 0, candidato: 1, no_sirve: 2, descartado: 3 };
  const todo = c("subreddits.json", { subreddits: [] });
  const subs = todo.subreddits.sort((a, b) => (ORDEN[a.estado] ?? 9) - (ORDEN[b.estado] ?? 9) || (a.prioridad ?? 5) - (b.prioridad ?? 5) || (b.miembros ?? 0) - (a.miembros ?? 0));
  const posts = c("posts.json", { posts: [] }).posts.filter((p) => p.estado !== "descartado").reverse().map((p) => ({ ...p, imagen: `/imgr/${p.id}` }));
  return { plan: todo.plan ?? null, subreddits: subs, posts, comentarios: c("comentarios.json", { comentarios: [] }).comentarios, perfil: "https://www.reddit.com/" };
}
function entradaReddit(texto, grupo = "reddit") {
  if (ocupado(grupo)) throw new Error(`Esperá que termine: ${ocupado(grupo).tipo}`); // sin dejar archivos sueltos
  mkdirSync(DIR_RD, { recursive: true });
  const f = join(DIR_RD, `entrada-${Date.now()}.txt`);
  writeFileSync(f, String(texto ?? ""));
  return f;
}
function guardarReddit(archivo, fn) {
  const r = join(DIR_RD, archivo);
  const d = leer(r);
  fn(d);
  guardar(r, d);
}
const subValido = (s) => { const n = String(s ?? "").trim().replace(/^\/?r\//i, ""); if (!/^\w{2,30}$/.test(n)) throw new Error("Nombre de subreddit inválido."); return n; };
// Rule34: solo lectura por la API oficial; estudio de nicho. La key va al archivo de claves.
const DIR_R34 = join(RAIZ, "config/rule34");
function rule34Panel() {
  let clave = false, usuario = null;
  try { const k = leer(cfg().publicacion.publicador); clave = !!k.rule34_api_key; usuario = k.rule34_user_id ?? null; } catch {}
  // Un solo análisis: se actualiza siempre a mano y cada corrida reemplaza la anterior (guarda sus números para comparar).
  const analisis = existsSync(join(DIR_R34, "analisis.json")) ? leer(join(DIR_R34, "analisis.json")) : null;
  // Asistente de subida: lo que preparó la IA para que la persona a cargo suba a mano (pendientes primero, por fecha sugerida).
  const ORD = { pendiente: 0, revisar: 1, subido: 2, saltado: 3 };
  const subidas = existsSync(join(DIR_R34, "subidas.json")) ? leer(join(DIR_R34, "subidas.json")).posts.map((p) => ({ ...p, img: `/img34/${p.id}` })).sort((a, b) => (ORD[a.estado] ?? 9) - (ORD[b.estado] ?? 9) || (a.fecha ?? "").localeCompare(b.fecha ?? "") || (a.orden ?? 99) - (b.orden ?? 99)) : [];
  return { clave, usuario, analisis, subidas };
}
function interaccionPanel() {
  if (!existsSync(DIR_INTER)) return null;
  const f = readdirSync(DIR_INTER).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().at(-1);
  if (!f) return null;
  const d = leer(join(DIR_INTER, f));
  return { fecha: d.fecha, generado: d.generado, nuevas: d.nuevas ?? null, ultimo_intento: ultimoIntentoInter(), obras: d.obras.map(({ mini, ...o }) => ({ ...o, mini: `/imgi/${basename(dirname(mini))}/${o.id}` })) };
}

/** Fecha y hora de Argentina de un instante: "mié 18 nov 20:00" (o solo "20:00"). */
const horaArgentina = (ms, solo = false) => {
  const o = { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return new Date(ms).toLocaleString("es-AR", solo ? o : { ...o, weekday: "short", day: "numeric", month: "short" });
};

/** Pixiv: lotes de posts de 3 imágenes (3 por día), aprobación aparte, subida con el asistente (pixiv.mjs). */
function estadoPixivPanel(c) {
  const cp = confPixiv(c);
  const todos = lotesPixiv(c).map((dir) => ({ dir, l: leer(join(dir, "lote.json")), est: estadoPixiv(dir).piezas, ok: aprobadoPixiv(dir) }));
  const piezas = todos.flatMap(({ l, est, ok }) => publicablesPixiv(l).map((p) => ({ ...p, lote: l.lote, e: est[p.n]?.pixiv ?? null, ok })));
  const porSalir = piezas.filter((p) => p.ok && p.fecha && p.e?.estado !== "PUBLICADO" && !["FALLIDO", "VENCIDO"].includes(p.e?.estado)).sort((a, b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`));
  const pub = piezas.filter((p) => p.e?.estado === "PUBLICADO");
  const ya = (p) => !!p.fecha && instante(p.fecha, p.hora, cp.zona).getTime() <= Date.now(); // llegó su franja
  const ocupadas = new Set(piezas.filter((p) => p.fecha && (p.e?.estado === "PUBLICADO" || (p.ok && !["FALLIDO", "VENCIDO"].includes(p.e?.estado)))).map((p) => `${p.fecha} ${p.hora}`));
  const ahora = Date.now();
  // franjas de las próximas 36 horas sin post aprobado (se avisa en el panel)
  // Fuera de pixiv.ventana no se publica a propósito (2026-11-23): esas franjas no son huecos.
  const v = cp.ventana, enVentana = (ms) => (!v?.desde || ms >= Date.parse(v.desde)) && (!v?.hasta || ms < Date.parse(v.hasta));
  const vacias = franjasPixiv(c, 3, sumarDias(hoyEn(cp.zona), -1)).filter((f) => f.ms > ahora && f.ms < ahora + 36 * 3600e3 && enVentana(f.ms) && !ocupadas.has(f.clave)).map((f) => ({ fecha: f.fecha, hora: f.hora, ar: horaArgentina(f.ms) }));
  const suma = (k) => pub.reduce((a, p) => a + (p.e?.metricas?.[k] ?? 0), 0);
  const hoy = hoyEn(cp.zona);
  return {
    conf: { hora: cp.hora, horas: horasPixivEn(hoyEn(cp.zona), cp), horas_ar: horasPixivEn(hoyEn(cp.zona), cp).map((h) => horaArgentina(instante(hoyEn(cp.zona), h, cp.zona).getTime(), true)), zona: cp.zona, modo: cp.modo, perfil: cp.perfil, por_post: POR_POST, posts_por_lote: cp.posts_por_lote },
    kpis: {
      publicados: pub.length,
      por_salir: porSalir.length,
      cubierto_hasta: porSalir.at(-1)?.fecha ?? null,
      proximo: porSalir[0] ? { fecha: porSalir[0].fecha, hora: porSalir[0].hora, ar: horaArgentina(instante(porSalir[0].fecha, porSalir[0].hora, cp.zona).getTime()), titulo: porSalir[0].titulo, personaje: porSalir[0].personaje } : null,
      // posts aprobados cuya franja ya llegó y todavía no se subieron (en modo confirmación esperan el clic de la persona a cargo)
      // pendientes para la persona a cargo: su franja pasó y no salieron solos (fallaron los reintentos o la PC estaba apagada)
      // (incluye los que fallaron: el panel los muestra con el botón "Publicar ahora", que dispara la misma automatización)
      para_subir: piezas.filter((p) => p.ok && p.e?.estado !== "PUBLICADO" && manualPixiv(p, p.e, cp)).sort((a, b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`)).map((p) => ({ lote: p.lote, n: p.n, titulo: p.titulo, personaje: p.personaje ?? "", fecha: p.fecha, hora: p.hora, ar: horaArgentina(instante(p.fecha, p.hora, cp.zona).getTime()), fallido: p.e?.estado === "FALLIDO", error: p.e?.error ?? null })),
      franjas_vacias: cp.activa ? vacias : [],
      auto: cp.modo === "auto" && existsSync(join(RAIZ, "config/pixiv-auto.json")) ? leer(join(RAIZ, "config/pixiv-auto.json")) : null,
      sin_aprobar: todos.filter((x) => !x.ok && publicablesPixiv(x.l).length && !Object.values(x.est).some((e) => e.pixiv?.estado)).length,
      con_problema: piezas.filter((p) => !p.ok && ["FALLIDO", "VENCIDO"].includes(p.e?.estado)).length, // los aprobados van en para_subir
      ultimo_link: [...pub].sort((a, b) => (b.e.enviado ?? "").localeCompare(a.e.enviado ?? ""))[0]?.e.link ?? null,
    },
    metricas: {
      actualizado: existsSync(RUTA_PX_MET) ? leer(RUTA_PX_MET).actualizado ?? null : null,
      por_personaje: Object.values(pub.filter((p) => p.e?.metricas).reduce((g, p) => { const k = p.personaje ?? "?"; (g[k] ??= { personaje: k, posts: 0, vistas: 0, likes: 0, marcadores: 0 }); g[k].posts++; g[k].vistas += p.e.metricas.vistas; g[k].likes += p.e.metricas.likes; g[k].marcadores += p.e.metricas.marcadores; return g; }, {}))
        .map((x) => ({ ...x, vistas_prom: Math.round(x.vistas / x.posts), marcadores_prom: Math.round((10 * x.marcadores) / x.posts) / 10 })).sort((a, b) => b.vistas_prom - a.vistas_prom),
      mejores: pub.filter((p) => p.e?.metricas).sort((a, b) => b.e.metricas.vistas - a.e.metricas.vistas).slice(0, 3).map((p) => ({ titulo: p.titulo, personaje: p.personaje ?? "", link: p.e.link ?? null, img: `/imgp/${p.lote}/${pNN(p.n)}/1`, ...p.e.metricas, enviado: p.e.enviado ?? null })),
      posts: pub.filter((p) => p.e?.metricas).length, vistas: suma("vistas"), likes: suma("likes"), marcadores: suma("marcadores"), comentarios: suma("comentarios") },
    publicados: [...pub].sort((a, b) => (b.e.enviado ?? "").localeCompare(a.e.enviado ?? "")).map((p) => ({
      id: idPieza(p.lote, p.n), fecha: p.fecha, hora: p.hora, personaje: p.personaje ?? "", texto: p.titulo, enviado: p.e.enviado ?? null, link: p.e.link ?? null, metricas: p.e.metricas ?? null, img: `/imgp/${p.lote}/${pNN(p.n)}/1`,
    })),
    stock: stockPixiv(c),
    interaccion: interaccionPanel(),
    concursos: concursosPanel(),
    lotes: todos.reverse().map(({ dir, l, est }) => {
      const aprob = existsSync(join(dir, "aprobacion.json")) ? leer(join(dir, "aprobacion.json")) : null;
      return {
        lote: l.lote, revisado: l.revisado ?? null,
        aprobado: aprob ? { fecha: aprob.fecha, vigente: aprob.huella === huellaPixiv(dir) } : null,
        piezas: l.piezas.map((p) => ({
          n: p.n, id: idPieza(l.lote, p.n), personaje: p.personaje ?? "", patreon: !!p.patreon, titulo: p.titulo ?? "", descripcion: p.descripcion ?? "",
          etiquetas: etiquetasDe(p), sugerente: p.sugerente ?? null, idea: p.idea ?? "", fecha: p.fecha, hora: p.hora,
          ar: p.fecha ? horaArgentina(instante(p.fecha, p.hora, p.zona ?? cp.zona).getTime()) : null, toca: !!p.fecha && instante(p.fecha, p.hora, p.zona ?? cp.zona).getTime() <= Date.now(), manual: manualPixiv(p, est[p.n]?.pixiv, cp),
          bloqueada: !!p.bloqueada, motivo: p.motivo ?? null, revision: p.revision ?? null,
          problemas: p.bloqueada ? [] : controlarPixiv(p), pixiv: est[p.n]?.pixiv ?? null,
          imgs: (p.imagenes ?? []).map((_, k) => `/imgp/${l.lote}/${pNN(p.n)}/${k + 1}`),
        })),
      };
    }),
  };
}

function dirLotePixiv(nombre) {
  const dir = lotesPixiv().find((d) => leer(join(d, "lote.json")).lote === nombre);
  if (!dir) throw new Error(`No existe el lote de Pixiv ${nombre}`);
  return dir;
}
function editablePixiv(dir, n = null) {
  const est = estadoPixiv(dir).piezas;
  const tocados = Object.entries(est).filter(([k, e]) => (n == null || +k === n) && ["PUBLICADO", "PROGRAMADO", "SUBIENDO"].includes(e.pixiv?.estado));
  if (tocados.length) throw new Error(n == null ? "Este lote ya tiene posts subidos a Pixiv: no se puede editar entero." : "Este post ya está en Pixiv: no se puede editar.");
}
function guardarConFechas(dir, l) { l.__dir = dir; asignarFechasPixiv(l); delete l.__dir; guardar(join(dir, "lote.json"), l); }

/** Qué se puede cambiar: un lote, mientras no tenga nada en Buffer; el backlog, los posts que todavía
 *  no tienen día asignado (sin n: todo el backlog, solo si no se usó ninguno). */
function editable(dir, n = null) {
  const l = leer(join(dir, "lote.json"));
  if (l.tipo === "backlog") {
    const usados = l.piezas.filter((p) => p.fecha && (n == null || p.n === n));
    if (usados.length) throw new Error(n == null ? "Este backlog ya tiene posts usados: no se puede revisar entero." : "Este post del backlog ya tiene día asignado: no se puede editar.");
    return;
  }
  const est = estadoDe(dir).piezas;
  if (Object.values(est).some((e) => enRedes(e, (r) => ["PROGRAMADO", "PUBLICADO"].includes(r.estado)))) throw new Error("Este lote ya tiene posts programados en Buffer: no se puede editar desde acá.");
}

const acciones = {
  async aprobar({ lote }) {
    const dir = dirLote(lote);
    editable(dir);
    const l = leer(join(dir, "lote.json"));
    if (!l.revisado) throw new Error("El lote no pasó la revisión.");
    const con = publicables(l).filter((p) => controlar(p, cfg(), { lote }).length);
    if (con.length) throw new Error(`Hay piezas con problemas (#${con.map((p) => p.n).join(", #")}): corregilas o bloquealas antes de aprobar.`);
    if (!publicables(l).length) throw new Error("No hay piezas para publicar.");
    // Las fechas de un lote se recalculan al aprobar: arranca después del último día ya cubierto
    // (por otros lotes o por el backlog), así no se pisan ni se pierden posts. El backlog no lleva fechas.
    asignarFechas(dir);
    guardar(join(dir, "aprobacion.json"), { fecha: new Date().toISOString(), huella: huellaLote(dir) });
    return { ok: true };
  },
  async desaprobar({ lote }) {
    const dir = dirLote(lote);
    if (leer(join(dir, "lote.json")).tipo !== "backlog") editable(dir);
    const r = join(dir, "aprobacion.json");
    if (existsSync(r)) renameSync(r, `${r}.anulada`);
    return { ok: true };
  },
  async texto({ lote, n, texto, alt, personaje }) {
    const dir = dirLote(lote);
    editable(dir, n);
    const ruta = join(dir, "lote.json");
    const l = leer(ruta);
    const p = l.piezas.find((x) => x.n === n);
    if (!p) throw new Error("No existe la pieza");
    if (typeof texto === "string") p.texto = texto.trim();
    if (typeof alt === "string") p.alt = alt.trim();
    if (typeof personaje === "string") p.personaje = personaje.trim();
    p.editado = new Date().toISOString();
    guardar(ruta, l);
    if (typeof personaje === "string") asignarFechas(dir); // reordena para no repetir personaje
    return { ok: true, problemas: controlar(p, cfg(), { lote }), peso: pesoX(textoX(p.texto, cfg(), p.personaje)), peso_bsky: pesoBsky(textoBsky(p.texto, cfg(), p.personaje)) };
  },
  async bloquear({ lote, n, bloquear }) {
    const dir = dirLote(lote);
    editable(dir, n);
    const ruta = join(dir, "lote.json");
    const l = leer(ruta);
    const p = l.piezas.find((x) => x.n === n);
    if (bloquear) Object.assign(p, { bloqueada: true, motivo: "Bloqueada a mano desde el panel." });
    else {
      if (!p.texto) throw new Error("Esta pieza no tiene texto: escribilo antes de desbloquearla.");
      Object.assign(p, { bloqueada: false, motivo: null });
    }
    guardar(ruta, l);
    asignarFechas(dir);
    return { ok: true };
  },
  async generar() {
    // Prioridad: carpeta "Lote…" con imágenes; si no hay, los textos del Backlog.
    if (carpetasLote().length) lanzar("Generar lote", ["herramientas/generar.mjs", "--origen", "lote"], "lotes");
    else if (pendientes(carpetas().backlog).length) lanzar("Armar lote desde el Backlog", ["herramientas/generar.mjs", "--origen", "backlog"], "lotes");
    else throw new Error('No hay imágenes nuevas: dejalas en una carpeta "Lote…" o en "Backlog".');
    return { ok: true };
  },
  async programar() { lanzar(`Programar en ${redes().map((r) => r.nombre).join(" y ")}`, ["herramientas/publicar.mjs"], "lotes"); return { ok: true }; },
  async revisar({ lote }) {
    const dir = dirLote(lote);
    editable(dir);
    lanzar(`Revisar ${lote}`, ["herramientas/revisar.mjs", dir], "lotes");
    return { ok: true };
  },
  async metricas() { lanzar("Actualizar métricas", ["herramientas/publicar.mjs", "--metricas", "--forzar"], "lotes"); return { ok: true }; },
  async detener({ grupo } = {}) { for (const [g, t] of trabajos) if (!grupo || g === grupo) t.proceso.kill(); return { ok: true }; },
  async automatizacion({ activa }) {
    // Activar registra (o vuelve a habilitar) la tarea diaria; pausar la deshabilita.
    if (activa) {
      const existe = (await ps(`[bool](Get-ScheduledTask -TaskName '${TAREA}' -ErrorAction SilentlyContinue)`)).s === "True";
      const r = existe
        ? await ps(`Enable-ScheduledTask -TaskName '${TAREA}' | Out-Null`)
        : await ps(`& '${join(RAIZ, "herramientas/registrar-tarea.ps1")}'`);
      if (r.code !== 0) throw new Error("No pude activar la tarea programada.");
    } else await ps(`Disable-ScheduledTask -TaskName '${TAREA}' -ErrorAction SilentlyContinue | Out-Null`);
    const c = cfg();
    c.automatizacion.activa = !!activa;
    guardar(CONFIG, c);
    return { ok: true };
  },
  async pixiv_aprobar({ lote }) {
    const dir = dirLotePixiv(lote);
    editablePixiv(dir);
    const l = leer(join(dir, "lote.json"));
    if (!l.revisado) throw new Error("El lote no pasó la revisión.");
    const con = publicablesPixiv(l).filter((p) => controlarPixiv(p).length);
    if (con.length) throw new Error(`Hay posts con problemas (#${con.map((p) => p.n).join(", #")}): corregilos o bloquealos antes de aprobar.`);
    if (!publicablesPixiv(l).length) throw new Error("No hay posts para publicar.");
    guardarConFechas(dir, l); // las fechas se recalculan al aprobar: arranca después del último día ya cubierto
    guardar(join(dir, "aprobacion.json"), { fecha: new Date().toISOString(), huella: huellaPixiv(dir) });
    return { ok: true };
  },
  async pixiv_desaprobar({ lote }) {
    const dir = dirLotePixiv(lote);
    editablePixiv(dir);
    const r = join(dir, "aprobacion.json");
    if (existsSync(r)) renameSync(r, `${r}.anulada`);
    return { ok: true };
  },
  async pixiv_texto({ lote, n, titulo, descripcion, personaje, sugerente }) {
    const dir = dirLotePixiv(lote);
    editablePixiv(dir, n);
    const l = leer(join(dir, "lote.json"));
    const p = l.piezas.find((x) => x.n === n);
    if (!p) throw new Error("No existe el post");
    if (typeof titulo === "string") p.titulo = titulo.trim();
    if (typeof descripcion === "string") p.descripcion = descripcion.trim();
    if (typeof personaje === "string") p.personaje = personaje.trim().toLowerCase();
    if (typeof sugerente === "boolean") p.sugerente = sugerente;
    p.editado = new Date().toISOString();
    guardarConFechas(dir, l);
    return { ok: true, problemas: controlarPixiv(p) };
  },
  async pixiv_bloquear({ lote, n, bloquear }) {
    const dir = dirLotePixiv(lote);
    editablePixiv(dir, n);
    const l = leer(join(dir, "lote.json"));
    const p = l.piezas.find((x) => x.n === n);
    if (bloquear) Object.assign(p, { bloqueada: true, motivo: "Bloqueado a mano desde el panel." });
    else { if (!p.titulo) throw new Error("Este post no tiene título: escribilo antes de desbloquearlo."); Object.assign(p, { bloqueada: false, motivo: null }); }
    guardarConFechas(dir, l);
    return { ok: true };
  },
  async pixiv_generar() { lanzar("Armar lote de Pixiv", ["herramientas/generar-pixiv.mjs"], "pixiv-lotes"); return { ok: true }; },
  async pixiv_subir({ lote, n }) {
    if (!aprobadoPixiv(dirLotePixiv(lote))) throw new Error("Aprobá el lote antes de subirlo.");
    lanzar(`Subir a Pixiv ${lote} #${n}`, ["herramientas/pixiv.mjs", "--subir", lote, String(n), "--confirmar"], "pixiv-chrome");
    return { ok: true };
  },
  // Publicar ahora: dispara la misma subida automática para un post que no salió a su hora.
  // Publicar tiene prioridad: si hay una búsqueda de Pixiv corriendo (sugerencias, concursos) la corta, porque usa el
  // mismo Chrome.
  async pixiv_publicar({ lote, n }) {
    if (!aprobadoPixiv(dirLotePixiv(lote))) throw new Error("Aprobá el lote antes de publicarlo.");
    const t = ocupado("pixiv-chrome");
    if (t) {
      if (!/sugerencias|concursos|métricas/i.test(t.tipo)) throw new Error(`Esperá que termine: ${t.tipo}`);
      t.proceso.kill();
      for (let i = 0; i < 40 && ocupado("pixiv-chrome"); i++) await new Promise((r) => setTimeout(r, 250));
      await ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*pixiv-perfil*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    lanzar(`Publicar en Pixiv ${lote} #${n}`, ["herramientas/pixiv.mjs", "--subir", lote, String(n)], "pixiv-chrome");
    return { ok: true };
  },
  async pixiv_sugerencias({ auto = false } = {}) {
    if (!confPixiv(cfg()).activa) { if (auto) return { ok: true, omitido: true }; throw new Error("Pixiv está apagado: activalo en Configuración."); }
    if (auto) {
      const u = ultimoIntentoInter();
      if (ocupado("pixiv-chrome") || (u && Date.now() - Date.parse(u) < 2 * 3600e3)) return { ok: true, omitido: true };
    }
    lanzar("Buscar sugerencias de interacción en Pixiv", ["herramientas/pixiv-sugerencias.mjs"], "pixiv-chrome");
    mkdirSync(DIR_INTER, { recursive: true });
    guardar(RUTA_INTENTO, { cuando: new Date().toISOString(), auto });
    return { ok: true };
  },
  async pixiv_metricas({ auto = false } = {}) {
    if (auto) {
      const u = existsSync(RUTA_PX_MET) ? leer(RUTA_PX_MET).intento : null;
      if (ocupado("pixiv-chrome") || (u && Date.now() - Date.parse(u) < 6 * 3600e3)) return { ok: true, omitido: true };
    }
    lanzar("Actualizar métricas de Pixiv", ["herramientas/pixiv-metricas.mjs"], "pixiv-chrome");
    guardar(RUTA_PX_MET, { ...(existsSync(RUTA_PX_MET) ? leer(RUTA_PX_MET) : {}), intento: new Date().toISOString() });
    return { ok: true };
  },
  async pixiv_concursos({ auto = false } = {}) {
    if (!confPixiv(cfg()).activa) { if (auto) return { ok: true, omitido: true }; throw new Error("Pixiv está apagado: activalo en Configuración."); }
    if (auto) {
      const u = concursosPanel().intento;
      if (ocupado("pixiv-chrome") || (u && Date.now() - Date.parse(u) < 12 * 3600e3)) return { ok: true, omitido: true };
    }
    lanzar("Actualizar concursos de Pixiv", ["herramientas/pixiv-concursos.mjs"], "pixiv-chrome");
    mkdirSync(DIR_INTER, { recursive: true });
    guardar(RUTA_CONC_INTENTO, { cuando: new Date().toISOString(), auto });
    return { ok: true };
  },
  async bsky_sugerencias({ auto = false } = {}) {
    if (!cfg().publicacion.bluesky?.activa) { if (auto) return { ok: true, omitido: true }; throw new Error("Bluesky no está vinculado: hacelo en Configuración."); }
    if (auto) { const u = bskyPanel().intento; if (ocupado("bsky") || (u && Date.now() - Date.parse(u) < 2 * 3600e3)) return { ok: true, omitido: true }; }
    lanzar("Buscar sugerencias de Bluesky", ["herramientas/bsky-sugerencias.mjs"], "bsky");
    mkdirSync(DIR_BS, { recursive: true });
    guardar(RUTA_BS_INTENTO, { cuando: new Date().toISOString(), auto });
    return { ok: true };
  },
  async bsky_estado({ fecha, tipo, id, estado }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? "") || !["post", "cuenta"].includes(tipo) || !["pendiente", "hecho", "saltado"].includes(estado)) throw new Error("Pedido inválido.");
    const ruta = join(DIR_BS, `${fecha}.json`);
    const d = leer(ruta);
    const x = (tipo === "post" ? d.posts.find((p) => p.uri === id) : d.cuentas.find((c) => c.did === id));
    if (!x) throw new Error("No lo encontré.");
    x.estado = estado; x.cuando = new Date().toISOString();
    guardar(ruta, d);
    if (estado !== "saltado") anotar(tipo, x, estado); // registro.md: lo que la persona a cargo confirmó (y lo que deshizo)
    return { ok: true };
  },
  async x_respuestas({ texto }) {
    if (/^\W*NO ACCESS\W*$/i.test(String(texto ?? "").trim())) throw new Error("La IA no pudo entrar a X: abrí x.com con la sesión de la cuenta de la marca en esa pestaña y volvé a pedirlo.");
    if (String(texto ?? "").trim().length < 10) throw new Error("Pegá lo que te dio Grok o Claude, o el texto de los posts.");
    lanzar("Respuestas para X", ["herramientas/x-respuestas.mjs", entradaReddit(texto, "xr")], "xr");
    return { ok: true };
  },
  // Borrar el historial del traductor.
  async x_traducciones_limpiar() {
    if (ocupado("xt")) throw new Error("Esperá que termine la traducción en curso.");
    guardar(RUTA_XT, { traducciones: [] });
    return { ok: true };
  },
  async x_traducir({ texto, tipo }) {
    if (String(texto ?? "").trim().length < 2) throw new Error("Pegá el texto que querés pasar al inglés.");
    if (String(texto).length > 3000) throw new Error("El texto es muy largo (máximo 3000 caracteres).");
    lanzar("Traducir con la voz de la marca", ["herramientas/x-traducir.mjs", entradaReddit(texto, "xt"), tipo === "respuesta" ? "respuesta" : "post"], "xt");
    return { ok: true };
  },
  async sorteo_crear({ red, titulo, post, condiciones, ganadores, suplentes, cuenta_min_dias, cierre }) {
    if (!CONDICIONES[red]) throw new Error("Red inválida.");
    titulo = String(titulo ?? "").trim().slice(0, 80);
    if (!titulo) throw new Error("Poné un nombre al sorteo.");
    post = String(post ?? "").trim() || null;
    if (post && !analizarLink(red, post)) throw new Error("El link no es de un post de esa red.");
    condiciones = (condiciones ?? []).filter((c) => CONDICIONES[red].includes(c));
    if (post && !condiciones.some((c) => c !== "sigue")) throw new Error("Con un post, elegí al menos una condición además de seguirte.");
    if (!post) condiciones = ["sigue"];
    const n = Math.max(1, Math.min(20, Math.round(+ganadores || 1)));
    const id = `${new Date().toISOString().slice(0, 10)}-${red}-${Date.now().toString(36)}`;
    mkdirSync(DIR_SORTEOS, { recursive: true });
    guardar(rutaSorteo(id), { id, red, titulo, post, condiciones, ganadores: n, suplentes: Math.max(0, Math.min(10, Math.round(+suplentes || 0))), cuenta_min_dias: Math.max(0, Math.round(+cuenta_min_dias || 0)), cierre: cierre || null, creado: new Date().toISOString() });
    return { ok: true, id };
  },
  async sorteo_estimar({ id }) {
    const s = sorteoDe(id);
    if (s.red !== "x") throw new Error("Solo los sorteos de X tienen costo.");
    lanzar(`Sorteo: costo en X (${s.titulo})`, ["herramientas/sorteo.mjs", "--estimar", id], "sorteos");
    return { ok: true };
  },
  async sorteo_revisar({ id, costo, finalizar = false }) {
    const s = sorteoDe(id);
    if (s.resultado) throw new Error("Este sorteo ya se sorteó.");
    if (s.red === "x") {
      // regla 4: el gasto en la API se confirma con el costo a la vista, cada vez
      if (!s.estimacion || Date.now() - Date.parse(s.estimacion.fecha) > 6 * 3600e3) throw new Error("Calculá el costo primero (la estimación tiene que ser de las últimas 6 horas).");
      if (+costo !== s.estimacion.costo_usd) throw new Error("Confirmá el costo estimado.");
      guardar(rutaSorteo(id), { ...s, costo_aprobado: true });
    }
    lanzar(finalizar ? `Sorteo: finalizar ahora (${s.titulo})` : `Sorteo: revisar participantes (${s.titulo})`, ["herramientas/sorteo.mjs", finalizar ? "--finalizar" : "--revisar", id], "sorteos");
    return { ok: true };
  },
  async sorteo_sortear({ id }) {
    const s = sorteoDe(id);
    lanzar(`Sorteo: sortear (${s.titulo})`, ["herramientas/sorteo.mjs", "--sortear", id], "sorteos");
    return { ok: true };
  },
  async sorteo_anular({ id }) {
    sorteoDe(id);
    renameSync(rutaSorteo(id), `${rutaSorteo(id)}.anulado`);
    return { ok: true };
  },
  async x_conectar() {
    if (!hayCredenciales()) throw new Error("Primero hay que crear la app en developer.x.com y guardar sus claves (ver docs/sorteos.md).");
    lanzar("Conectar X", ["herramientas/x-api.mjs", "--conectar"], "sorteos");
    return { ok: true };
  },
  async x_respuesta_estado({ id, estado }) {
    if (!["pendiente", "hecho", "saltado"].includes(estado)) throw new Error("Estado inválido.");
    const d = leer(RUTA_XR);
    const p = d.tandas.flatMap((t) => t.posts).find((x) => x.id === String(id));
    if (!p) throw new Error("No la encontré.");
    p.estado = estado;
    p.cuando = new Date().toISOString();
    guardar(RUTA_XR, d);
    return { ok: true };
  },
  // Historial de interacción: lo que ya marcó Hecho o Saltar, de todos los días, en lista compacta.
  // Sale de la vista principal para no sumar scroll; se ve con el botón "Historial" de cada red.
  async historial({ red }) {
    const filas = [];
    const dias = (dir) => (existsSync(dir) ? readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().reverse() : []);
    if (red === "pixiv") for (const f of dias(DIR_INTER)) {
      const d = leer(join(DIR_INTER, f));
      for (const o of d.obras ?? []) if (o.estado && o.estado !== "pendiente") filas.push({ tipo: "obra", fecha: d.fecha, id: o.id, estado: o.estado, cuando: o.cuando ?? d.generado, titulo: o.titulo || "Sin título", sub: `${o.autor ?? ""} · ${o.personaje ?? ""}`, texto: o.estado === "hecho" ? o.comentario_en : /^Saltado solo/.test(o.nota ?? "") ? o.nota : null, link: o.link, perfil: o.perfil, mini: o.mini ? `/imgi/${basename(dirname(o.mini))}/${o.id}` : null });
    }
    if (red === "bsky") for (const f of dias(DIR_BS)) {
      const d = leer(join(DIR_BS, f));
      for (const p of d.posts ?? []) if (p.estado && p.estado !== "pendiente") filas.push({ tipo: "post", fecha: d.fecha, id: p.uri, estado: p.estado, cuando: p.cuando ?? d.generado, titulo: p.autor, sub: `@${p.handle}`, texto: p.estado === "hecho" ? p.respuesta : /^Saltado solo/.test(p.nota ?? "") ? p.nota : null, link: p.link, mini: p.mini ? `/imgb/${basename(dirname(p.mini))}/${basename(p.mini, ".jpg")}` : null });
      for (const c of d.cuentas ?? []) if (c.estado === "hecho" || c.estado === "saltado") filas.push({ tipo: "cuenta", fecha: d.fecha, id: c.did, estado: c.estado, cuando: c.cuando ?? d.generado, titulo: c.nombre, sub: `@${c.handle} · cuenta`, texto: null, link: c.link, mini: null });
    }
    if (red === "x" && existsSync(RUTA_XR)) for (const t of leer(RUTA_XR).tandas) {
      for (const p of t.posts) if (p.estado && p.estado !== "pendiente") filas.push({ tipo: "x", id: p.id, estado: p.estado, cuando: p.cuando ?? t.creado, titulo: p.cuenta ?? "Post de X", sub: p.resumen ?? "", texto: p.estado === "hecho" ? p.respuesta : /^Saltado solo/.test(p.nota ?? "") ? p.nota : null, link: p.link, mini: p.mini ? `/imgx/${basename(p.mini, ".jpg")}` : null });
    }
    return { filas: filas.sort((a, b) => String(b.cuando ?? "").localeCompare(String(a.cuando ?? ""))) };
  },
  async reddit_buscar({ tema }) {
    if (!String(tema ?? "").trim()) throw new Error("Escribí qué buscar.");
    lanzar(`Buscar subreddits: ${String(tema).slice(0, 40)}`, ["herramientas/reddit.mjs", "--buscar", entradaReddit(tema)], "reddit");
    return { ok: true };
  },
  async reddit_reglas({ sub, texto }) {
    if (String(texto ?? "").trim().length < 20) throw new Error("Pegá las reglas del subreddit.");
    lanzar(`Clasificar reglas de r/${subValido(sub)}`, ["herramientas/reddit.mjs", "--reglas", subValido(sub), entradaReddit(texto)], "reddit");
    return { ok: true };
  },
  async reddit_preparar({ sub }) { lanzar(`Preparar post para r/${subValido(sub)}`, ["herramientas/reddit.mjs", "--preparar", subValido(sub)], "reddit"); return { ok: true }; },
  async r34_clave({ api_key, user_id }) {
    const key = String(api_key ?? "").trim(), uid = String(user_id ?? "").trim();
    if (!/^[A-Za-z0-9]{16,256}$/.test(key)) throw new Error("La API key no tiene el formato esperado (letras y números).");
    if (!/^\d{1,12}$/.test(uid)) throw new Error("El user_id son solo números.");
    const ruta = cfg().publicacion.publicador;
    const k = existsSync(ruta) ? leer(ruta) : {};
    guardar(ruta, { ...k, rule34_api_key: key, rule34_user_id: uid });
    lanzar("Probar la key de Rule34", ["herramientas/rule34.mjs", "--probar"], "rule34");
    return { ok: true };
  },
  async r34_preparar({ carpeta, source }) {
    const c = String(carpeta ?? "").trim().replace(/^"|"$/g, ""), s = String(source ?? "").trim();
    if (!c || !existsSync(c)) throw new Error("No encuentro esa carpeta.");
    if (!/^https:\/\/(www\.)?(patreon\.com|pixiv\.net|x\.com|twitter\.com)\/\S+$/.test(s) || /[?#]/.test(s)) throw new Error("El source tiene que ser la dirección limpia (sin ? ni #) del post de Patreon, Pixiv o X donde están las imágenes.");
    lanzar("Preparar subidas a Rule34", ["herramientas/rule34-subidas.mjs", "--preparar", c, s], "rule34");
    return { ok: true };
  },
  async r34_marcar({ id, estado, post_id }) {
    if (!["subido", "saltado", "pendiente"].includes(estado)) throw new Error("Estado inválido.");
    const { cargarSubidas, agendar } = await import("../rule34-subidas.mjs");
    const todo = cargarSubidas();
    const p = todo.posts.find((x) => x.id === String(id));
    if (!p) throw new Error("No encontré esa subida.");
    p.estado = estado;
    if (estado === "subido") { p.subido = new Date().toISOString(); const n = String(post_id ?? "").match(/\d{5,}/)?.[0]; if (n) p.post_id = n; } else { delete p.subido; delete p.post_id; }
    guardar(join(DIR_R34, "subidas.json"), agendar(todo));
    return { ok: true };
  },
  async r34_abrir({ id }) {
    const { cargarSubidas } = await import("../rule34-subidas.mjs");
    const p = cargarSubidas().posts.find((x) => x.id === String(id));
    if (!p || !existsSync(p.archivo)) throw new Error("No encuentro el archivo.");
    spawn("explorer", [`/select,${normalize(p.archivo)}`], { detached: true }).unref();
    return { ok: true };
  },
  async r34_analisis({ nicho }) {
    const n = String(nicho ?? "").trim().toLowerCase() || "league_of_legends";
    if (!/^[\w:()'.\- ]{2,80}$/.test(n)) throw new Error("Usá etiquetas de Rule34, p. ej. league_of_legends");
    lanzar(`Análisis de Rule34: ${n.slice(0, 40)}`, ["herramientas/rule34.mjs", "--analisis", n], "rule34");
    return { ok: true };
  },
  async reddit_comentario({ texto }) {
    if (String(texto ?? "").trim().length < 5) throw new Error("Pegá el título o el texto del post.");
    lanzar("Comentario sugerido para Reddit", ["herramientas/reddit.mjs", "--comentario", entradaReddit(texto)], "reddit");
    return { ok: true };
  },
  async reddit_sub_estado({ sub, estado }) {
    if (!["sirve", "no_sirve", "descartado", "candidato"].includes(estado)) throw new Error("Estado inválido.");
    const n = subValido(sub).toLowerCase();
    guardarReddit("subreddits.json", (d) => { const s = d.subreddits.find((x) => x.nombre.toLowerCase() === n); if (!s) throw new Error("No encontré ese subreddit."); s.estado = estado; });
    return { ok: true };
  },
  async reddit_sub_agregar({ sub }) {
    const n = subValido(sub);
    if (!existsSync(join(DIR_RD, "subreddits.json"))) { mkdirSync(DIR_RD, { recursive: true }); guardar(join(DIR_RD, "subreddits.json"), { subreddits: [] }); }
    guardarReddit("subreddits.json", (d) => { if (!d.subreddits.some((x) => x.nombre.toLowerCase() === n.toLowerCase())) d.subreddits.push({ nombre: n, estado: "candidato", verificado: false, agregado: new Date().toISOString(), notas: "Agregado a mano: pegá sus reglas para clasificarlo." }); });
    return { ok: true };
  },
  async reddit_post_estado({ id, estado }) {
    if (!["preparado", "publicado", "descartado"].includes(estado)) throw new Error("Estado inválido.");
    guardarReddit("posts.json", (d) => { const p = d.posts.find((x) => x.id === String(id)); if (!p) throw new Error("No encontré ese post."); p.estado = estado; if (estado === "publicado") p.publicado = new Date().toISOString(); });
    return { ok: true };
  },
  async interaccion_estado({ fecha, id, estado }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? "") || !["pendiente", "hecho", "saltado"].includes(estado)) throw new Error("Pedido inválido.");
    const ruta = join(DIR_INTER, `${fecha}.json`);
    const d = leer(ruta);
    const o = d.obras.find((x) => x.id === String(id));
    if (!o) throw new Error("No encontré esa obra.");
    o.estado = estado;
    o.cuando = new Date().toISOString();
    guardar(ruta, d);
    return { ok: true };
  },
  async pixiv_login() { lanzar("Iniciar sesión en Pixiv", ["herramientas/pixiv.mjs", "--login"], "pixiv-chrome"); return { ok: true }; },
  async abrir() { spawn("explorer", [normalize(carpetas().nuevas)], { detached: true }).unref(); return { ok: true }; },
  async cerrar() { setTimeout(() => process.exit(0), 200); return { ok: true }; },
};

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".ico": "image/x-icon" };

createServer(async (req, res) => {
  ultimoUso = Date.now();
  const url = new URL(req.url, "http://x");
  const json = (code, d) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
  try {
    // Solo desde esta PC y desde el propio panel (evita que otra página use el panel con un dominio apuntado a 127.0.0.1).
    const propios = [`127.0.0.1:${PUERTO}`, `localhost:${PUERTO}`];
    if (!propios.includes(req.headers.host)) return json(403, { error: "pedido no permitido" });
    if (req.headers.origin && !propios.some((h) => req.headers.origin === `http://${h}`)) return json(403, { error: "pedido no permitido" });
    const asis = url.pathname.match(/^\/api\/(asis_[a-z0-9_]+)$/)?.[1];
    if (req.method === "POST" && asis) {
      if (req.headers["x-panel"] !== "1") return json(403, { error: "pedido no permitido" });
      if (!Object.hasOwn(accionesAsistente, asis)) return json(404, { error: "acción desconocida" });
      let body = "";
      for await (const d of req) { body += d; if (body.length > 20000) return json(413, { error: "demasiado texto" }); }
      return json(200, await accionesAsistente[asis](body ? JSON.parse(body) : {}));
    }
    if (url.pathname === "/prompt.txt") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return createReadStream(join(RAIZ, "docs/prompt-agente.md")).pipe(res); }
    if (url.pathname === "/configuracion" || (url.pathname === "/" && !configurado())) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return createReadStream(join(PUBLICO, "asistente.html")).pipe(res); }
    if (!configurado() && url.pathname.startsWith("/api/")) return json(409, { error: "Falta completar la configuración inicial." });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const m = cfg().marca ?? {}, limpio = (x) => String(x ?? "").replace(/[<>&"'`\\$]/g, "");
      const v = { MARCA: limpio(m.nombre), X: limpio(m.x) || "tu cuenta de X", X_USUARIO: limpio(m.x).replace(/^@/, ""), BSKY: limpio(cfg().publicacion.bluesky?.canal?.handle) };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(readFileSync(join(PUBLICO, "index.html"), "utf8").replace(/\{\{(MARCA|X|X_USUARIO|BSKY)\}\}/g, (_, k) => v[k]));
    }
    if (req.method === "GET" && url.pathname === "/api/estado") return json(200, await estado());
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      // Solo pedidos del propio panel (evita que otra página del navegador dispare acciones).
      if (req.headers["x-panel"] !== "1") return json(403, { error: "pedido no permitido" });
      const accion = acciones[url.pathname.slice(5)];
      if (!accion) return json(404, { error: "acción desconocida" });
      let body = "";
      for await (const d of req) body += d;
      return json(200, await accion(body ? JSON.parse(body) : {}));
    }
    const smd = url.pathname.match(/^\/sorteo\/([a-z0-9-]+)\.md$/);
    if (smd) {
      const f = join(DIR_SORTEOS, `${smd[1]}.md`);
      if (!existsSync(f)) return json(404, { error: "todavía no hay registro" });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return createReadStream(f).pipe(res);
    }
    const imgx = url.pathname.match(/^\/imgx\/([a-z0-9]+)$/);
    if (imgx) {
      const f = join(RAIZ, "config/x-imgs", `${imgx[1]}.jpg`);
      if (!existsSync(f)) return json(404, { error: "falta la imagen" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
      return createReadStream(f).pipe(res);
    }
    const imgb = url.pathname.match(/^\/imgb\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+)$/);
    if (imgb) {
      const f = join(DIR_BS, imgb[1], `${imgb[2]}.jpg`);
      if (!existsSync(f)) return json(404, { error: "falta la miniatura" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
      return createReadStream(f).pipe(res);
    }
    const img34 = url.pathname.match(/^\/img34\/([a-z0-9]+)$/);
    if (img34) {
      const f = join(DIR_R34, "mini", `${img34[1]}.jpg`);
      if (!existsSync(f)) return json(404, { error: "falta la imagen" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
      return createReadStream(f).pipe(res);
    }
    const imgr = url.pathname.match(/^\/imgr\/([a-z0-9]+)$/);
    if (imgr) {
      const f = join(DIR_RD, "imagenes", `${imgr[1]}.jpg`);
      if (!existsSync(f)) return json(404, { error: "falta la imagen" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache", "Content-Disposition": `inline; filename="post-${imgr[1]}.jpg"` });
      return createReadStream(f).pipe(res);
    }
    const imgi = url.pathname.match(/^\/imgi\/(\d{4}-\d{2}-\d{2})\/(\d+)$/);
    if (imgi) {
      const f = join(DIR_INTER, imgi[1], `${imgi[2]}.png`);
      if (!existsSync(f)) return json(404, { error: "falta la miniatura" });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
      return createReadStream(f).pipe(res);
    }
    const imgp = url.pathname.match(/^\/imgp\/([\w-]+)\/(p\d\d)\/([1-9])$/);
    if (imgp) {
      const f = join(dirLotePixiv(imgp[1]), imgp[2], `${imgp[3]}.jpg`);
      if (!existsSync(f)) return json(404, { error: "falta la imagen" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
      return createReadStream(f).pipe(res);
    }
    const img = url.pathname.match(/^\/img\/([\w-]+)\/(p\d\d)$/);
    if (img) {
      const f = join(dirLote(img[1]), img[2], "imagen.jpg");
      if (!existsSync(f)) return json(404, { error: "falta la imagen" }); // sin esto, el panel se caía
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
      return createReadStream(f).pipe(res);
    }
    const f = join(PUBLICO, url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^([\\/]\.\.)+/, ""));
    if (f.startsWith(PUBLICO) && existsSync(f)) {
      res.writeHead(200, { "Content-Type": TIPOS[extname(f)] ?? "application/octet-stream" });
      return createReadStream(f).pipe(res);
    }
    json(404, { error: "no encontrado" });
  } catch (e) {
    json(400, { error: e.message });
  }
}).listen(PUERTO, "127.0.0.1", () => console.log(`Panel en http://127.0.0.1:${PUERTO}`))
  .on("error", (e) => { console.error(e.code === "EADDRINUSE" ? "El panel ya estaba abierto." : e.message); process.exit(0); });

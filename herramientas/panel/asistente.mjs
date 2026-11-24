// Asistente de primer inicio: pide y prueba todo lo que el sistema necesita. Cada paso se guarda por separado, así se puede
// cortar y seguir después. Las claves quedan en config/claves.json (fuera de git) y nunca vuelven al navegador.
// Nada de acá publica: con Buffer solo se lee la lista de canales; en Supabase se sube y se borra una imagen de prueba.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cfg as leerCfg, CLAVES_RUTA, chrome, CONFIG, configurado, guardar, leerClaves, RAIZ } from "../comun.mjs";
import { comandoIA, probarIA } from "../ia.mjs";
import { hacerMarca } from "../marca.mjs";

const DIAS = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"];
const guardarCfg = (c) => {
  mkdirSync(dirname(CONFIG), { recursive: true });
  delete c.publicacion.publicador; // la ruta de las claves no se guarda
  guardar(CONFIG, c);
};
const guardarClaves = (x) => { mkdirSync(dirname(CLAVES_RUTA), { recursive: true }); guardar(CLAVES_RUTA, { ...leerClaves(), ...x }); };
const paso = (c, n, ok) => { c.asistente = { ...(c.asistente ?? {}), [n]: ok }; };
const texto = (v, max, nombre, { obligatorio = true } = {}) => {
  const t = String(v ?? "").trim();
  if (!t && obligatorio) throw new Error(`Falta: ${nombre}.`);
  if (t.length > max || /[<>"'`\\$\n\r]/.test(t)) throw new Error(`${nombre}: muy largo o con caracteres no permitidos.`);
  return t;
};
const link = (v, nombre) => {
  const t = texto(v, 200, nombre, { obligatorio: false });
  if (t && !/^https:\/\/\S+$/.test(t)) throw new Error(`${nombre}: tiene que empezar con https://`);
  return t;
};
const clave = (v, nombre) => {
  const t = String(v ?? "").trim();
  if (t && !/^[\x21-\x7e]{10,3000}$/.test(t)) throw new Error(`${nombre}: no tiene el formato esperado.`);
  return t;
};
const horas = (v, nombre) => {
  const l = [...new Set(String(v ?? "").split(/[\s,;]+/).filter(Boolean))].sort();
  if (!l.length || l.length > 8 || l.some((h) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(h))) throw new Error(`${nombre}: horas con formato 20:00, separadas por coma (de 1 a 8).`);
  return l;
};
const tiene = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); return r.status === 0 ? String(r.stdout || r.stderr).split("\n")[0].trim().slice(0, 60) : null; };

function requisitos() {
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 21;
  return [
    { id: "windows", nombre: "Windows", ok: process.platform === "win32", detalle: process.platform === "win32" ? "Detectado" : "La automatización usa el Programador de tareas de Windows" },
    { id: "node", nombre: "Node.js 21 o más nuevo", ok: nodeOk, detalle: process.version, link: "https://nodejs.org" },
    { id: "ffmpeg", nombre: "ffmpeg y ffprobe", ok: !!(tiene("ffmpeg", ["-version"]) && tiene("ffprobe", ["-version"])), detalle: tiene("ffmpeg", ["-version"]) ?? "Prepara las imágenes y pone la marca de agua", link: "https://ffmpeg.org/download.html" },
    { id: "chrome", nombre: "Google Chrome", ok: !!chrome(), detalle: chrome() ? "Detectado" : "Arma la marca de agua y abre Pixiv", link: "https://www.google.com/chrome/" },
    { id: "deps", nombre: "Dependencias del proyecto", ok: existsSync(join(RAIZ, "node_modules/puppeteer-core")), detalle: "npm ci" },
    { id: "codex", nombre: "Codex CLI", ok: !!comandoIA("codex"), detalle: comandoIA("codex") ? "Detectado" : "npm install -g @openai/codex, después: codex login", opcional: !!comandoIA("claude") },
    { id: "claude", nombre: "Claude Code", ok: !!comandoIA("claude"), detalle: comandoIA("claude") ? "Detectado" : "Solo si preferís usar Claude", opcional: true },
  ];
}

async function buffer(api, query, variables = {}) {
  const r = await fetch("https://api.buffer.com", { method: "POST", signal: AbortSignal.timeout(20e3), headers: { Authorization: `Bearer ${api}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(r.status === 401 || r.status === 403 ? "Buffer rechazó la clave: revisá que esté completa." : `Buffer respondió con un error (${r.status}).`);
  return j.data;
}
async function canalesBuffer(api) {
  const { account } = await buffer(api, "query { account { organizations { id } } }");
  const out = [];
  for (const o of account.organizations) out.push(...(await buffer(api, "query($i: ChannelsInput!) { channels(input: $i) { id name service displayName externalLink isDisconnected } }", { i: { organizationId: o.id } })).channels);
  return out.filter((x) => ["twitter", "bluesky"].includes(x.service));
}

// Imagen JPG mínima para probar el alojamiento.
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==", "base64");
async function probarSupabase({ supabase_url: u, supabase_secret_key: k, supabase_bucket: b }) {
  const h = { Authorization: `Bearer ${k}`, apikey: k };
  const pedir = (ruta, op = {}) => fetch(`${u}/storage/v1/${ruta}`, { signal: AbortSignal.timeout(20e3), ...op, headers: { ...h, ...(op.headers ?? {}) } });
  const r = await pedir(`bucket/${b}`);
  if (r.ok) { if (!(await r.json()).public) throw new Error(`El bucket "${b}" existe pero es privado: Buffer no podría leer las imágenes. Usá otro nombre o hacelo público en Supabase.`); }
  else {
    const n = await pedir("bucket", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b, name: b, public: true }) });
    if (!n.ok) throw new Error(n.status === 401 || n.status === 403 || n.status === 400 ? "Supabase rechazó la clave o el nombre: tiene que ser la clave secreta (service_role o sb_secret), no la pública." : `Supabase respondió ${n.status}.`);
  }
  const nombre = `prueba/${Date.now()}.jpg`;
  const s = await pedir(`object/${b}/${nombre}`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: JPG });
  if (!s.ok) throw new Error(`No pude subir la imagen de prueba (${s.status}).`);
  const v = await fetch(`${u}/storage/v1/object/public/${b}/${nombre}`, { method: "HEAD", signal: AbortSignal.timeout(20e3) });
  await pedir(`object/${b}/${nombre}`, { method: "DELETE" }).catch(() => {});
  if (!v.ok) throw new Error("La imagen subió pero no se ve desde afuera: el bucket tiene que ser público.");
}

const faltantes = (c) => {
  const a = c.asistente ?? {};
  return [["ia", "Inteligencia artificial"], ["marca", "Marca"], ["carpetas", "Carpetas"], ["buffer", "Buffer"], ["imagenes", "Alojamiento de imágenes"], ["horarios", "Horarios"]].filter(([k]) => !a[k]).map(([, n]) => n);
};

export const accionesAsistente = {
  async asis_estado() {
    const c = leerCfg(), k = leerClaves(), p = c.publicacion;
    return {
      configurado: configurado(), requisitos: requisitos(), hecho: c.asistente ?? {}, faltan: faltantes(c),
      proveedor: c.ia?.proveedor ?? "codex",
      marca: { ...c.marca, texto_marca: c.marca_agua?.texto ?? "", excluidos: (c.personajes_excluidos ?? []).join(", "), zona: p.zona },
      carpeta: c.contenido ?? "",
      buffer: { clave: !!k.buffer_api_key, x: p.canal?.nombre || null, bsky: p.bluesky?.canal?.handle || null },
      supabase: { url: !!k.supabase_url, clave: !!k.supabase_secret_key, bucket: k.supabase_bucket ?? "" },
      horarios: { x: p.agenda?.lun?.join(", ") ?? "", bsky: (p.bluesky?.agenda ?? p.agenda)?.lun?.join(", ") ?? "", bloquear: c.pixiv?.activa && c.pixiv.modo === "auto" },
      pixiv: { activa: !!c.pixiv?.activa, usuario_id: c.pixiv?.usuario_id ?? "", horas: (c.pixiv?.horas ?? []).join(", ") },
      prompt: readFileSync(join(RAIZ, "docs/prompt-agente.md"), "utf8"),
    };
  },
  async asis_ia({ proveedor }) {
    if (!["codex", "claude"].includes(proveedor)) throw new Error("Elegí Codex o Claude.");
    if (!comandoIA(proveedor)) throw new Error(proveedor === "codex" ? "No encontré Codex CLI. Instalalo (npm install -g @openai/codex), corré codex login y volvé a probar." : "No encontré Claude Code en esta PC.");
    const c = leerCfg();
    c.ia = { proveedor }; paso(c, "ia", false); guardarCfg(c);
    await probarIA(c);
    const n = leerCfg(); paso(n, "ia", true); guardarCfg(n);
    return { ok: true, mensaje: "La IA responde, escribe archivos y ve imágenes." };
  },
  async asis_marca(d) {
    const c = leerCfg();
    const x = texto(d.x, 30, "Usuario de X", { obligatorio: false }).replace(/^@/, "");
    if (x && !/^\w{1,15}$/.test(x)) throw new Error("Usuario de X: solo letras, números y guion bajo.");
    const zona = texto(d.zona, 60, "Zona horaria");
    try { new Intl.DateTimeFormat("es", { timeZone: zona }); } catch { throw new Error("Zona horaria no válida (ejemplo: America/New_York)."); }
    c.marca = { ...c.marca, nombre: texto(d.nombre, 60, "Nombre de la marca"), x: x ? `@${x}` : "", patreon: link(d.patreon, "Link de Patreon") };
    const t = texto(d.texto_marca, 60, "Texto de la marca de agua");
    c.publicacion.zona = zona;
    c.personajes_excluidos = texto(d.excluidos, 400, "Personajes excluidos", { obligatorio: false }).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (!c.marca.patreon) c.lote.con_link_patreon = 0; // sin link no puede haber cierres con link
    await hacerMarca(t, join(RAIZ, "config/marca/marca.png"));
    c.marca_agua = { ...c.marca_agua, texto: t, imagen: "config/marca/marca.png" };
    paso(c, "marca", true); guardarCfg(c);
    return { ok: true, mensaje: "Marca guardada y marca de agua creada." };
  },
  async asis_carpetas({ carpeta }) {
    const base = String(carpeta ?? "").trim().replace(/^"|"$/g, "");
    if (!base || !isAbsolute(base)) throw new Error("Pegá la ruta completa de una carpeta, por ejemplo D:\\Posts.");
    if (resolve(base).toLowerCase().startsWith(resolve(RAIZ).toLowerCase())) throw new Error("Elegí una carpeta fuera del proyecto: las imágenes no van al repo.");
    const c = leerCfg(), j = (x) => join(resolve(base), x).replace(/\\/g, "/");
    Object.assign(c, { contenido: j("interno"), publicaciones: j("Publicaciones"), lotes: j("Publicaciones/Lotes") });
    c.pixiv = { ...c.pixiv, bancos: [j("Banco")] };
    for (const d of [c.contenido, c.publicaciones, c.lotes, j("Publicaciones/Backlog"), j("Publicaciones/Lotes-Pixiv"), j("Banco")]) mkdirSync(d, { recursive: true });
    paso(c, "carpetas", true); guardarCfg(c);
    return { ok: true, mensaje: `Carpetas listas. Dejá las imágenes en ${j("Publicaciones/Backlog")}` };
  },
  async asis_buffer({ clave: v }) {
    const nueva = clave(v, "Clave de Buffer"), api = nueva || leerClaves().buffer_api_key;
    if (!api) throw new Error("Pegá la clave de Buffer.");
    const lista = await canalesBuffer(api);
    if (nueva) guardarClaves({ buffer_api_key: nueva });
    return { canales: lista.map((x) => ({ id: x.id, red: x.service === "twitter" ? "X" : "Bluesky", nombre: x.displayName || x.name, cuenta: x.name, desconectado: x.isDisconnected })) };
  },
  async asis_canales({ x, bsky }) {
    const api = leerClaves().buffer_api_key;
    if (!api) throw new Error("Primero cargá la clave de Buffer.");
    if (!x && !bsky) throw new Error("Elegí al menos un canal (X o Bluesky).");
    const lista = await canalesBuffer(api), c = leerCfg();
    const elegir = (id, servicio) => {
      if (!id) return null;
      const ch = lista.find((y) => y.id === id && y.service === servicio);
      if (!ch) throw new Error("Ese canal ya no está en Buffer.");
      if (ch.isDisconnected) throw new Error(`El canal ${ch.name} está desconectado: reconectalo en Buffer.`);
      return ch;
    };
    const cx = elegir(x, "twitter"), cb = elegir(bsky, "bluesky");
    c.publicacion.canal = { servicio: "twitter", nombre: cx?.name ?? "", buffer_id: cx?.id ?? "" };
    if (cx) c.marca.x = `@${cx.name.replace(/^@/, "")}`;
    if (cb) {
      const did = (cb.externalLink ?? "").match(/did:[a-z0-9]+:[A-Za-z0-9._:-]+$/)?.[0];
      if (!did) throw new Error("Buffer no informó la identidad de la cuenta de Bluesky.");
      const r = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`, { signal: AbortSignal.timeout(20e3) });
      if (!r.ok) throw new Error("No pude comprobar la cuenta en Bluesky.");
      const { handle } = await r.json();
      const antes = c.publicacion.bluesky ?? {};
      c.publicacion.bluesky = { ...antes, activa: true, desde: antes.canal?.did === did && antes.desde ? antes.desde : new Date().toISOString(), desfase_min: 0, canal: { servicio: "bluesky", handle, did, buffer_id: cb.id } };
      c.marca.bluesky = `https://bsky.app/profile/${handle}`;
    } else {
      c.publicacion.bluesky = { ...c.publicacion.bluesky, activa: false, canal: { servicio: "bluesky", handle: "", did: "", buffer_id: "" } };
      c.marca.bluesky = "";
    }
    paso(c, "buffer", true); guardarCfg(c);
    return { ok: true, mensaje: `Vinculado: ${[cx && `X @${cx.name}`, cb && `Bluesky ${c.publicacion.bluesky.canal.handle}`].filter(Boolean).join(" y ")}.` };
  },
  async asis_imagenes({ url, clave: v, bucket }) {
    const k = leerClaves();
    const u = (String(url ?? "").trim() || k.supabase_url || "").replace(/\/+$/, "");
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(u)) throw new Error("La dirección tiene esta forma: https://abcd1234.supabase.co");
    const b = String(bucket ?? "").trim() || k.supabase_bucket || "x-bs-auto";
    if (!/^[a-z0-9-]{3,60}$/.test(b)) throw new Error("Nombre del bucket: minúsculas, números y guiones.");
    const datos = { supabase_url: u, supabase_secret_key: clave(v, "Clave secreta de Supabase") || k.supabase_secret_key, supabase_bucket: b };
    if (!datos.supabase_secret_key) throw new Error("Pegá la clave secreta de Supabase.");
    // La clave guardada nunca se manda a una dirección distinta de aquella para la que se cargó.
    if (!String(v ?? "").trim() && k.supabase_url && k.supabase_url !== u) throw new Error("Cambió la dirección: pegá también la clave secreta de ese proyecto.");
    await probarSupabase(datos);
    guardarClaves(datos);
    const c = leerCfg(); paso(c, "imagenes", true); guardarCfg(c);
    return { ok: true, mensaje: "Alojamiento probado: la imagen sube y se ve desde afuera." };
  },
  async asis_horarios({ x, bsky }) {
    const c = leerCfg(), por = (l) => Object.fromEntries(DIAS.map((d) => [d, [...l]]));
    const hx = horas(x, "Horarios de X"), hb = horas(bsky, "Horarios de Bluesky");
    c.publicacion.agenda = por(hx); c.publicacion.horas = hx; c.publicacion.cambios_agenda = [];
    c.publicacion.bluesky = { ...c.publicacion.bluesky, agenda: por(hb), cambios_agenda: [] };
    const juntas = (l) => l.some((h, i) => i && (Number(h.slice(0, 2)) * 60 + Number(h.slice(3))) - (Number(l[i - 1].slice(0, 2)) * 60 + Number(l[i - 1].slice(3))) < 180);
    c.publicacion.separacion_min = juntas(hx) || juntas(hb) ? 30 : 180;
    paso(c, "horarios", true); guardarCfg(c);
    return { ok: true, mensaje: "Horarios guardados." };
  },
  async asis_pixiv({ activa, usuario_id, horas: h }) {
    const c = leerCfg();
    if (activa && !/^\d{1,12}$/.test(String(usuario_id ?? "").trim())) throw new Error("El ID de Pixiv son solo números (está en la dirección de tu perfil).");
    const id = String(usuario_id ?? "").trim();
    c.pixiv = { ...c.pixiv, activa: !!activa, modo: "confirmar", ...(activa ? { usuario_id: id, perfil: `https://www.pixiv.net/en/users/${id}`, horas: horas(h || "21:00", "Horarios de Pixiv") } : {}) };
    paso(c, "pixiv", true); guardarCfg(c);
    return { ok: true, mensaje: activa ? "Pixiv activado: después iniciá sesión desde la pestaña Pixiv del panel." : "Pixiv apagado." };
  },
  async asis_terminar() {
    const c = leerCfg(), f = faltantes(c);
    if (f.length) throw new Error(`Todavía falta: ${f.join(", ")}.`);
    const r = requisitos().filter((x) => !x.ok && !x.opcional && x.id !== "codex");
    if (r.length) throw new Error(`Faltan programas: ${r.map((x) => x.nombre).join(", ")}.`);
    c.configurado = true; // la automatización queda como estaba: apagada hasta que la enciendan en el panel
    guardarCfg(c);
    return { ok: true };
  },
};

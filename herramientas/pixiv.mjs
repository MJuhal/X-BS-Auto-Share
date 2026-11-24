// Pixiv: asistente de subida con un perfil de Chrome propio del proyecto (config/pixiv-perfil, fuera de git).
// Pixiv no tiene API para subir obras: el script abre la página de subida, completa todo y la persona a cargo toca "Publicar"
// (modo confirmación). Solo la cuenta de marca: antes de tocar nada verifica que la sesión sea la del ID de la config.
//   node herramientas/pixiv.mjs --login        abre Pixiv para iniciar sesión (una sola vez; la sesión queda guardada)
//   node herramientas/pixiv.mjs --sesion       dice si hay sesión y de qué cuenta (sin ventana)
//   Modo "auto": toca "Post" solo; lo dispara herramientas/pixiv-auto.mjs cada 15 minutos.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { cfg, chrome, guardar, leer, RAIZ, sha256 } from "./comun.mjs";
import { aprobadoPixiv, confPixiv as confComun, controlarPixiv, estadoPixiv, etiquetasDe, lotesPixiv } from "./pixiv-comun.mjs";

const CHROME = chrome();
export const PERFIL = join(RAIZ, "config/pixiv-perfil");
const confPixiv = (c = cfg()) => confComun(c);

export async function abrir({ visible = true } = {}) {
  if (!CHROME) throw new Error("No encontré Google Chrome.");
  return puppeteer.launch({
    executablePath: CHROME,
    headless: !visible,
    userDataDir: PERFIL,
    defaultViewport: null,
    args: ["--window-size=1280,960", "--lang=en-US", "--no-first-run", "--no-default-browser-check"],
  });
}

/** ID de la cuenta con sesión en ese navegador (null si no hay sesión). La cookie PHPSESSID es "<id>_<hash>". */
export async function cuentaDe(navegador) {
  const pg = (await navegador.pages())[0] ?? (await navegador.newPage());
  const cookies = await pg.browserContext().cookies("https://www.pixiv.net");
  const s = cookies.find((k) => k.name === "PHPSESSID")?.value ?? "";
  return /^\d+_/.test(s) ? s.split("_")[0] : null;
}

async function login() {
  const { usuario_id } = confPixiv();
  const nav = await abrir();
  const pg = (await nav.pages())[0];
  await pg.goto("https://accounts.pixiv.net/login?return_to=https%3A%2F%2Fwww.pixiv.net%2Fen%2F", { waitUntil: "domcontentloaded" });
  console.log("Iniciá sesión en la ventana de Chrome con la cuenta la marca. Espero hasta 15 minutos...");
  const fin = Date.now() + 15 * 60e3;
  while (Date.now() < fin) {
    const id = await cuentaDe(nav).catch(() => null);
    if (id === usuario_id) { console.log(`Sesión iniciada con la cuenta de marca (${id}). Ya podés cerrar la ventana.`); await new Promise((r) => setTimeout(r, 3000)); await nav.close(); return; }
    if (id && id !== usuario_id) { console.log(`Ojo: la sesión es de otra cuenta (${id}), no de la marca (${usuario_id}). Cerrá sesión y entrá con la marca.`); }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await nav.close();
  throw new Error("No se inició sesión a tiempo.");
}

async function sesion() {
  const nav = await abrir({ visible: false });
  const id = await cuentaDe(nav);
  await nav.close();
  const { usuario_id } = confPixiv();
  console.log(id ? (id === usuario_id ? `Sesión OK: cuenta de marca ${id}` : `Sesión de OTRA cuenta (${id}); se espera ${usuario_id}`) : "Sin sesión: correr --login");
  return id;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sube un post aprobado. Modo "confirmar" (por defecto): completa todo y espera que la persona a cargo toque "Post".
 *  Modo "auto" (fase 2, config pixiv.modo): toca "Post" solo. --probar: completa, saca una captura y cierra sin publicar. */
export async function subir(nombreLote, n, { probar = false, confirmar = false } = {}) {
  const c = cfg();
  const cp = confComun(c);
  const dir = lotesPixiv(c).find((d) => leer(join(d, "lote.json")).lote === nombreLote);
  if (!dir) throw new Error(`No existe el lote de Pixiv ${nombreLote}`);
  if (!probar && !aprobadoPixiv(dir)) throw new Error("El lote no está aprobado (o cambió después de aprobarlo).");
  const lote = leer(join(dir, "lote.json"));
  const p = lote.piezas.find((x) => x.n === n);
  if (!p || p.bloqueada) throw new Error(`El post #${n} no existe o está bloqueado.`);
  const prob = controlarPixiv(p);
  if (prob.length) throw new Error(`El post #${n} tiene problemas: ${prob.join("; ")}`);
  const rutaEst = join(dir, "estado.json");
  const estado = estadoPixiv(dir);
  const previo = estado.piezas[n]?.pixiv;
  if (previo?.estado === "PUBLICADO") throw new Error(`El post #${n} ya está publicado: ${previo.link}`);
  if (previo?.estado === "SUBIENDO" && Date.now() - Date.parse(previo.desde) < 30 * 60e3) throw new Error(`El post #${n} se está subiendo ahora.`);
  // Cada imagen tiene que ser la que se aprobó (SHA-256).
  const archivos = p.imagenes.map((i) => { const f = join(dir, i.archivo); if (!existsSync(f) || sha256(f) !== i.sha256) throw new Error(`La imagen ${i.archivo} no es la que se aprobó.`); return f; });
  const etiquetas = etiquetasDe(p);
  const marcar = (e) => { estado.piezas[n] = { ...(estado.piezas[n] ?? {}), pixiv: { ...(estado.piezas[n]?.pixiv ?? {}), ...e } }; guardar(rutaEst, estado); };

  // confirmar: la persona a cargo toca "Post" aunque la config esté en auto (subida a mano desde el panel de un post pendiente).
  const auto = cp.modo === "auto" && !confirmar;
  // Siempre con ventana para publicar (2026-11-18): desde un Chrome invisible Pixiv no publica (el Post no llega);
  // visible funciona. La tarea corre con la sesión de Windows iniciada, así que siempre hay escritorio.
  const nav = await abrir({ visible: !probar });
  try {
    const id = await cuentaDe(nav);
    if (id !== cp.usuario_id) throw new Error(id ? `La sesión es de otra cuenta (${id}); se espera la de marca (${cp.usuario_id}).` : "No hay sesión en Pixiv: tocá \"Iniciar sesión en Pixiv\".");
    const pg = (await nav.pages())[0];
    await pg.goto("https://www.pixiv.net/illustration/create", { waitUntil: "networkidle2", timeout: 60000 });
    await pg.waitForSelector('input[type=file][name="files[]"]', { timeout: 30000 });
    const input = await pg.$('input[type=file][name="files[]"]');
    await input.uploadFile(...archivos);
    await pg.waitForFunction((k) => document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length >= k, { timeout: 60000 }, archivos.length).catch(() => {});
    await espera(1500);
    await pg.type('input[name="title"]', p.titulo, { delay: 15 });
    await pg.type('textarea[name="comment"]', p.descripcion, { delay: 5 });
    // Etiquetas: el campo de texto sin nombre de la sección "Tags"; cada una se confirma con Enter.
    // (es el que tiene el contador "N/10" en su etiqueta)
    const campoTags = await pg.evaluateHandle(() => [...document.querySelectorAll('input[type=text]:not([name])')].find((e) => /\b\d+\s*\/\s*10\b/.test(e.closest("label")?.innerText ?? e.parentElement?.parentElement?.innerText ?? "")));
    if (!campoTags.asElement()) throw new Error("No encontré el campo de etiquetas (¿cambió el formulario de Pixiv?).");
    for (const t of etiquetas) { await campoTags.asElement().click(); await pg.keyboard.type(t, { delay: 10 }); await pg.keyboard.press("Enter"); await espera(350); }
    const radio = async (name, value) => {
      const ok = await pg.evaluate((name, value) => { const r = document.querySelector(`input[type=radio][name="${name}"][value="${value}"]`); if (!r) return false; (r.closest("label") ?? r).click(); return r.checked; }, name, value);
      if (!ok) throw new Error(`No pude elegir ${name}=${value} en el formulario.`);
    };
    await radio("x_restrict", "general"); // todo público (las imágenes del Backlog son SFW)
    await espera(700);
    // "Adult content" (obligatorio al elegir All ages): se decide post por post mirando pose y ropa (redacción +
    // revisión, campo `sugerente`; la persona a cargo lo puede cambiar en el panel). Ante la duda, "Included".
    const sugerente = p.sugerente !== false;
    const okAdulto = await pg.evaluate((incluido) => {
      const radios = [...document.querySelectorAll("input[type=radio]")].filter((r) => !["x_restrict", "ai_type", "restrict", "allow_comment"].includes(r.name));
      const r = radios.find((x) => (incluido ? /included/i : /^\s*no\s*$/i).test(x.closest("label")?.innerText ?? ""));
      if (!r) return null;
      (r.closest("label") ?? r).click();
      return r.checked;
    }, sugerente);
    if (okAdulto === false) throw new Error("No pude responder \"Adult content\" en el formulario.");
    if (okAdulto === null) console.log("Ojo: no apareció la pregunta \"Adult content\" (¿cambió el formulario?).");
    await radio("ai_type", "aiGenerated"); // obligatorio en Pixiv: obra hecha con IA
    await radio("restrict", "public");
    await espera(800);
    // Control de lo cargado antes de publicar.
    const cargado = await pg.evaluate(() => ({
      titulo: document.querySelector('input[name="title"]').value,
      descripcion: document.querySelector('textarea[name="comment"]').value,
      tags: (document.body.innerText.match(/(\d+)\/10/) ?? [])[1],
      edad: document.querySelector('input[name="x_restrict"]:checked')?.value,
      ia: document.querySelector('input[name="ai_type"]:checked')?.value,
      piezas: (document.body.innerText.match(/(\d+)\s+Pieces?/) ?? [])[1],
      postHabilitado: [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Post" && !b.disabled && !b.closest("header")),
    }));
    console.log("Cargado:", JSON.stringify(cargado));
    if (cargado.titulo !== p.titulo || cargado.edad !== "general" || cargado.ia !== "aiGenerated" || Number(cargado.piezas) !== archivos.length) throw new Error(`El formulario no quedó como se esperaba: ${JSON.stringify(cargado)}`);
    if (Number(cargado.tags) !== etiquetas.length) console.log(`Ojo: Pixiv muestra ${cargado.tags}/10 etiquetas y se cargaron ${etiquetas.length}.`);

    if (probar) {
      await pg.screenshot({ path: join(RAIZ, "config/pixiv-prueba.png"), fullPage: true });
      console.log(`Prueba completa (no se publicó nada). Captura: ${join(RAIZ, "config/pixiv-prueba.png")}`);
      return;
    }
    marcar({ estado: "SUBIENDO", desde: new Date().toISOString() });
    if (auto) {
      // El "Post" del formulario es el que está DESPUÉS del título en la página. Hay otro "Post" en la barra de arriba
      // (abre el menú Illustrations/Manga...) que no siempre está dentro de <header>: el 2026-11-18 y el 2026-11-19 a
      // las 23:00 de Japón se tocó ese y el post no salió.
      await pg.keyboard.press("Escape").catch(() => {});
      const tocado = await pg.evaluate(() => {
        const titulo = document.querySelector('input[name="title"]');
        const b = [...document.querySelectorAll("button")].filter((x) => x.innerText.trim() === "Post" && !x.disabled && !x.hasAttribute("aria-haspopup") && !x.hasAttribute("aria-expanded") && !!(titulo.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
        if (!b) return false;
        b.scrollIntoView({ block: "center" });
        b.click();
        return true;
      });
      if (!tocado) { estado.piezas[n] = { ...(estado.piezas[n] ?? {}) }; delete estado.piezas[n].pixiv; guardar(rutaEst, estado); throw new Error("No encontré el botón Post del formulario (¿cambió Pixiv?). No se publicó nada."); }
    } else console.log("Todo cargado. Revisalo en la ventana de Chrome y tocá \"Post\". Espero hasta 20 minutos...");
    // Éxito: Pixiv muestra la obra nueva (link a /artworks/<id>). Si se cierra la ventana sin publicar, vuelve a pendiente.
    const fin = Date.now() + (auto ? 3 : 20) * 60e3; // en automático, si en 3 minutos no apareció la obra, no va a aparecer
    let link = null;
    while (Date.now() < fin && !link) {
      await espera(2000);
      const pags = await nav.pages().catch(() => []);
      if (!pags.length) break;
      for (const x of pags) {
        const u = x.url();
        if (/\/artworks\/\d+/.test(u)) link = u.match(/https:\/\/www\.pixiv\.net\/(?:en\/)?artworks\/\d+/)?.[0];
        else if (!/illustration\/create$/.test(u)) link = await x.evaluate(() => [...document.querySelectorAll('a[href*="/artworks/"]')].map((a) => a.href).find((h) => /\/artworks\/\d+$/.test(h)) ?? null).catch(() => null);
        if (link) break;
      }
    }
    if (!link) {
      // Diagnóstico: qué quedó en pantalla (diálogos, errores del formulario) cuando no se pudo confirmar.
      const pagina = (await nav.pages().catch(() => []))[0];
      if (pagina) {
        await pagina.screenshot({ path: join(RAIZ, "config/pixiv-fallo.png"), fullPage: true }).catch(() => {});
        const visto = await pagina.evaluate(() => ({ url: location.href, dialogos: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => d.innerText.slice(0, 300)), errores: [...document.querySelectorAll('[class*="error" i], [class*="warning" i]')].map((e) => e.innerText.trim()).filter(Boolean).slice(0, 5), captcha: !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"]') })).catch(() => null);
        console.log("Diagnóstico:", JSON.stringify(visto));
      }
    }
    // ¿Quedó el formulario sin enviar? (sigue en la página de crear, con el título cargado y las 3 imágenes): entonces
    // no se publicó y se puede reintentar sin riesgo de duplicar.
    const sinEnviar = !link && auto && await (async () => {
      const pg2 = (await nav.pages().catch(() => [])).find((x) => /illustration\/create/.test(x.url()));
      return !!pg2 && await pg2.evaluate((t, k) => document.querySelector('input[name="title"]')?.value === t && Number((document.body.innerText.match(/(\d+)\s+Pieces?/) ?? [])[1]) === k, p.titulo, archivos.length).catch(() => false);
    })();
    if (link) {
      marcar({ estado: "PUBLICADO", error: null, link, enviado: new Date().toISOString(), id: link.match(/\d+$/)[0] });
      console.log(`Publicado en Pixiv: ${link}`);
      // Saca el aviso de "subida automática frenada" del panel (ya salió).
      const rutaAuto = join(RAIZ, "config/pixiv-auto.json");
      if (existsSync(rutaAuto)) guardar(rutaAuto, { ...leer(rutaAuto), ok: true, mensaje: null, ultimo: { lote: nombreLote, n, cuando: new Date().toISOString() } });
    } else if (sinEnviar) {
      estado.piezas[n] = { ...(estado.piezas[n] ?? {}) }; delete estado.piezas[n].pixiv; guardar(rutaEst, estado);
      throw new Error("Pixiv no tomó el clic en Post (el formulario quedó sin enviar). No se publicó nada: se puede reintentar.");
    } else if (auto) {
      // Se tocó "Post" pero no apareció la obra: no se reintenta solo (podría duplicarse). la persona a cargo revisa el perfil.
      marcar({ estado: "FALLIDO", error: "Se tocó Post pero no pude confirmar la publicación: revisá el perfil de Pixiv antes de reintentar." });
      throw new Error("No pude confirmar la publicación.");
    } else { estado.piezas[n] = { ...(estado.piezas[n] ?? {}) }; delete estado.piezas[n].pixiv; guardar(rutaEst, estado); console.log("No se publicó (se cerró la ventana o pasó el tiempo). El post sigue pendiente."); }
  } finally { await nav.close().catch(() => {}); }
}

if (resolve(process.argv[1] ?? "").toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const a = process.argv[2];
  try {
    if (a === "--login") await login();
    else if (a === "--sesion") await sesion();
    else if (a === "--subir" || a === "--probar") await subir(process.argv[3], Number(process.argv[4]), { probar: a === "--probar", confirmar: process.argv.includes("--confirmar") });
    else console.log("Uso: node herramientas/pixiv.mjs --login | --sesion | --subir <lote> <n> [--confirmar] | --probar <lote> <n>");
  } catch (e) { console.error(e.message); process.exit(1); }
}

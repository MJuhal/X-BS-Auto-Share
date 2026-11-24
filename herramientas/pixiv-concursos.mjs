// Concursos oficiales de Pixiv: le sirven los que aceptan obras hechas con IA y fanart.
// Lee la lista de concursos abiertos, abre las bases de cada concurso nuevo y la IA las clasifica (acepta IA,
// acepta fanart, condiciones, tema, etiqueta, cierre). Los ya clasificados no se vuelven a leer; los cerrados se van.
// Solo lectura: no participa de nada ni publica (eso lo decide la persona a cargo, con un post de un lote aprobado).
//   node herramientas/pixiv-concursos.mjs   actualiza config/interaccion/concursos.json
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cfg, guardar, leer, RAIZ } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";
import { confPixiv } from "./pixiv-comun.mjs";
import { abrir, cuentaDe } from "./pixiv.mjs";

const DIR = join(RAIZ, "config/interaccion");
const RUTA = join(DIR, "concursos.json");
mkdirSync(DIR, { recursive: true });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (a, b) => a + Math.random() * (b - a);
const cp = confPixiv(cfg());

const previo = existsSync(RUTA) ? leer(RUTA) : { concursos: [] };
const conocidos = new Map(previo.concursos.map((k) => [k.slug, k]));
const nav = await abrir({ visible: false });
let lista = [];
const nuevos = [];
try {
  if ((await cuentaDe(nav)) !== cp.usuario_id) throw new Error('No hay sesión de la cuenta de marca en Pixiv: tocá "Iniciar sesión en Pixiv".');
  const pg = (await nav.pages())[0];
  console.log("Lista de concursos abiertos");
  await pg.goto("https://www.pixiv.net/contest/", { waitUntil: "networkidle2", timeout: 60000 });
  await espera(azar(2000, 3500));
  lista = await pg.evaluate(() => {
    const m = new Map();
    for (const a of document.querySelectorAll('a[href*="/contest/"]')) {
      const href = a.href.split("?")[0];
      if (/\/novel\//.test(href)) continue; // los de novela no aplican
      const slug = href.match(/pixiv\.net\/contest\/([\w-]+)\/?$/)?.[1];
      const titulo = a.innerText.trim().split(/\r?\n/)[0]?.trim();
      if (!slug || !titulo || m.has(slug)) continue;
      let k = a.parentElement;
      for (let i = 0; i < 6 && k && !/〆|Open for application|応募受付中/.test(k.innerText); i++) k = k.parentElement;
      const txt = k?.innerText ?? "";
      m.set(slug, { slug, link: href, titulo, abierto: /Open for application|応募受付中/.test(txt) });
    }
    return [...m.values()].filter((x) => x.abierto);
  });
  for (const k of lista) {
    if (conocidos.has(k.slug)) continue;
    console.log(`Bases: ${k.titulo}`);
    await pg.goto(k.link, { waitUntil: "networkidle2", timeout: 60000 });
    await espera(azar(2000, 3500));
    const portada = await pg.evaluate(() => document.body.innerText);
    // Pestaña de bases ("Rules to applying" / "応募要項"), si existe.
    const hayBases = await pg.evaluate(() => {
      const el = [...document.querySelectorAll("a,button,li,div,span")].find((e) => /^(Rules to applying|Rules|応募要項|Guidelines)$/i.test(e.innerText?.trim() ?? ""));
      if (!el) return false;
      el.click();
      return true;
    });
    if (hayBases) await espera(azar(2000, 3000));
    const bases = hayBases ? await pg.evaluate(() => document.body.innerText) : "";
    const texto = `${portada}\n\n=== BASES ===\n${bases}`.replace(/\n{3,}/g, "\n\n").slice(0, 12000);
    nuevos.push({ ...k, texto, revisado: new Date().toISOString() });
    await espera(azar(3000, 6000));
  }
} finally { await nav.close().catch(() => {}); }

// Clasificación de los nuevos con la IA.
if (nuevos.length) {
  const rutaNuevos = join(DIR, "concursos-nuevos.json");
  guardar(rutaNuevos, nuevos.map((k) => ({ slug: k.slug, titulo: k.titulo, texto: k.texto, acepta_ia: null, acepta_fanart: null, condiciones: null, tema: null, etiqueta: null, cierre: null, terminado: null })));
  console.log(`== Clasifico ${nuevos.length} concurso(s)`);
  const prompt = [
    `En ${rutaNuevos} hay concursos oficiales de Pixiv con el texto de su página y sus bases (campo "texto", puede estar en cualquier idioma).`,
    `Para cada uno completá, leyendo el texto (no inventes: si no lo dice, poné "no_dice" o null):`,
    `"acepta_ia": "si" si las obras hechas total o parcialmente con IA pueden participar (aunque sea con límite, como "una obra con IA por persona"), "no" si las excluyen, no entran al premio o están prohibidas, "no_dice" si no lo menciona.`,
    `"acepta_fanart": "si" si acepta fanart u obras derivadas de personajes existentes (aunque sea con condiciones de los dueños de los derechos), "no" si pide solo obra original o solo un personaje o una marca concreta que no es de videojuegos ajenos, "no_dice" si no lo dice.`,
    `"condiciones": en español, una línea con las condiciones que importan para participar con fanart hecho con IA (límite de obras con IA, marcar "AI-generated", R-18 excluido, tema obligatorio, etc.).`,
    `"tema": en español, una línea con el tema del concurso. "etiqueta": la etiqueta obligatoria para participar, tal cual (sin #), o null. "cierre": fecha de cierre de la recepción en formato AAAA-MM-DD si figura, o null. "terminado": true si la página dice que el concurso ya terminó (ganadores anunciados, sorteo hecho, recepción cerrada), si no false.`,
    `Borrá el campo "texto" de cada concurso al terminar. No toques otros archivos.`,
  ].join(" ");
  const codigo = await ejecutarIA(prompt, { herramientas: "Read,Edit,Write", dirs: [DIR] });
  const clasif = new Map(leer(rutaNuevos).map((k) => [k.slug, k]));
  for (const k of nuevos) {
    const c = clasif.get(k.slug) ?? {};
    delete k.texto;
    Object.assign(k, { acepta_ia: c.acepta_ia ?? "no_dice", acepta_fanart: c.acepta_fanart ?? "no_dice", condiciones: c.condiciones ?? null, tema: c.tema ?? null, etiqueta: c.etiqueta ?? null, cierre: c.cierre ?? null, terminado: c.terminado === true });
    conocidos.set(k.slug, k);
  }
  console.log(codigo === 0 ? "LISTO" : `La clasificación terminó con código ${codigo}`);
}

// Quedan solo los abiertos (los que ya no están en la lista cerraron), con lo que sirve primero.
const abiertos = new Set(lista.map((k) => k.slug));
const sirve = (k) => k.acepta_ia === "si" && k.acepta_fanart === "si";
const hoy = new Date().toISOString().slice(0, 10);
const vigente = (k) => !k.terminado && (!k.cierre || k.cierre >= hoy);
const concursos = [...conocidos.values()].filter((k) => abiertos.has(k.slug) && vigente(k)).map((k) => ({ ...k, sirve: sirve(k) }))
  .sort((a, b) => b.sirve - a.sirve || (a.cierre ?? "9999").localeCompare(b.cierre ?? "9999"));
guardar(RUTA, { actualizado: new Date().toISOString(), concursos });
console.log(`Concursos abiertos: ${concursos.length}; aceptan IA y fanart: ${concursos.filter((k) => k.sirve).map((k) => k.titulo).join(", ") || "ninguno"}.`);

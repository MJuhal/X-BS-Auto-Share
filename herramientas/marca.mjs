// Arma la marca de agua (docs/marca-de-agua.html con el texto de config marca_agua.texto) como PNG transparente.
//   node herramientas/marca.mjs [salida.png]
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { cfg, chrome, RAIZ } from "./comun.mjs";

const escapar = (t) => String(t).replace(/[&<>"']/g, (x) => `&#${x.charCodeAt(0)};`);
export async function hacerMarca(texto, salida = join(RAIZ, "config/marca/marca.png")) {
  const exe = chrome();
  if (!exe) throw new Error("No encontré Google Chrome.");
  if (!texto?.trim()) throw new Error("Falta el texto de la marca de agua.");
  let html = readFileSync(join(RAIZ, "docs/marca-de-agua.html"), "utf8").replace("{{TEXTO}}", () => escapar(texto.trim()));
  if (!/patreon/i.test(texto)) html = html.replace(/<svg[\s\S]*?<\/svg>/, ""); // el logo de Patreon solo si la marca es de Patreon
  mkdirSync(dirname(salida), { recursive: true });
  const nav = await puppeteer.launch({ executablePath: exe });
  try {
    const pg = await nav.newPage();
    await pg.setViewport({ width: 1600, height: 300, deviceScaleFactor: 2 });
    await pg.setContent(html, { waitUntil: "load" });
    await (await pg.$("#marca")).screenshot({ path: salida, omitBackground: true });
  } finally { await nav.close(); }
  return salida;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  hacerMarca(cfg().marca_agua?.texto, process.argv[2]).then((x) => console.log("marca guardada en", x), (e) => { console.error(e.message); process.exitCode = 1; });

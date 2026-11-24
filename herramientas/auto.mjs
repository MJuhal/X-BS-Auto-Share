// Corrida diaria de la automatización (la lanza la tarea programada):
//   1. si hay una carpeta Lote… (en la carpeta de entrada, config "publicaciones") con imágenes, arma el lote (prioridad; queda para aprobar);
//   2. si quedan pocos posts aprobados por salir, arma el próximo lote de 10 desde el Backlog (queda para aprobar);
//   3. programa en X y en Bluesky lo aprobado y rellena con el backlog aprobado los días sin post (publicar.mjs);
//   4. trae las métricas de lo publicado.
//   node herramientas/auto.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { aprobado, backlogListo, carpetas, carpetasLote, cfg, estadoDe, hoyEn, leer, lotes, pendientes, porSalir, publicables, RAIZ } from "./comun.mjs";
import { aprobadoPixiv, confPixiv, estadoPixiv, lotesPixiv, porSalirPixiv, stockPixiv } from "./pixiv-comun.mjs";

const c = cfg();
const log = (m) => { console.log(m); appendFileSync(join(RAIZ, "config/auto.log"), `${new Date().toISOString()} ${m}\n`); };
const correr = (args) => spawnSync("node", args, { cwd: RAIZ, stdio: "inherit" }).status;

if (!c.automatizacion.activa) {
  log("pausada: no hago nada");
  process.exit(0);
}

// 1. Lotes nuevos (uno por carpeta "Lote…", de la más vieja a la más nueva).
for (let vuelta = 0; c.automatizacion.armar_lotes !== false && vuelta < 5 && carpetasLote(c).length; vuelta++) {
  log(`hay un Lote nuevo (${carpetasLote(c)[0]}): lo armo`);
  const r = correr(["herramientas/generar.mjs", "--origen", "lote"]);
  log(`generar lote terminó con código ${r}`);
  if (r !== 0) break;
}

// 2. Lote nuevo a partir del Backlog, cuando quedan pocos posts aprobados por salir y no hay otro
//    lote esperando aprobación (así la persona a cargo tiene un par de días para aprobarlo).
const quedan = porSalir(c);
const esperando = lotes(c).some((d) => !aprobado(d) && publicables(leer(join(d, "lote.json"))).length && !Object.keys(estadoDe(d).piezas).length);
// automatizacion.armar_lotes false: no arma lotes solo.
const armar = c.automatizacion.armar_lotes !== false;
if (!armar) log("armar lotes automáticamente está apagado (automatizacion.armar_lotes): solo programo");
else if (!esperando && quedan <= (c.automatizacion.generar_si_quedan ?? 3) && pendientes(carpetas(c).backlog, c).length) {
  log(`quedan ${quedan} post(s) aprobados por salir: armo el próximo lote desde el Backlog`);
  log(`generar lote desde el backlog terminó con código ${correr(["herramientas/generar.mjs", "--origen", "backlog"])}`);
} else if (esperando) log("hay un lote esperando aprobación: no armo otro");

// Pixiv: lote nuevo (posts de 3 imágenes, 3 por día) cuando quedan pocos aprobados por salir y no hay otro esperando.
// En modo "confirmar" los posts los sube la persona a cargo con un clic desde el panel; en modo "auto", pixiv-auto.mjs.
const cpx = confPixiv(c);
if (cpx.activa && armar) {
  const esperandoPx = lotesPixiv(c).some((d) => !aprobadoPixiv(d) && !existsSync(join(d, "aprobacion.json")));
  const quedanPx = porSalirPixiv(c);
  if (!esperandoPx && quedanPx <= cpx.generar_si_quedan && stockPixiv(c).some((s) => s.posts > 0)) {
    log(`Pixiv: quedan ${quedanPx} post(s) aprobados por salir: armo el próximo lote`);
    log(`generar lote de Pixiv terminó con código ${correr(["herramientas/generar-pixiv.mjs"])}`);
  } else if (esperandoPx) log("Pixiv: hay un lote esperando aprobación: no armo otro");
  // La subida en modo "auto" la hace herramientas/pixiv-auto.mjs (tarea de Windows cada 15 minutos), no esta corrida diaria.
}

// 3. Programar (incluye rellenar con el backlog los días sin post) y 4. métricas.
log(`programar en X y Bluesky terminó con código ${correr(["herramientas/publicar.mjs"])}`);
log(`métricas terminó con código ${correr(["herramientas/publicar.mjs", "--metricas"])}`);
log(`posts aprobados por salir: ${porSalir(c)}; imágenes sin usar en el Backlog: ${pendientes(carpetas(c).backlog, c).length}`);

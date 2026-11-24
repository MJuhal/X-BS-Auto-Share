// Pixiv en automático: lo corre una tarea de Windows a la hora de cada franja y cada 15 minutos
// durante los 45 minutos siguientes.
//   - Sube el post cuya franja acaba de llegar. Si falla, lo reintenta en la corrida siguiente: 4 intentos en total
//     (el primero + 3 reintentos, uno cada 15 minutos).
//   - Si no salió en esa ventana, en las franjas siguientes se sube solo como atrasado (ver abajo), y el panel muestra
//     "Publicar ahora" para dispararlo antes.
//   - Un post que quedó "subiendo" o "falló" después de tocar Post no se reintenta nunca solo (podría duplicarse).
//   - Iniciar sesión en Pixiv lo hace siempre la persona a cargo. Los avisos quedan en config/pixiv-auto.json (el panel los muestra).
//   node herramientas/pixiv-auto.mjs            corre una vez
//   node herramientas/pixiv-auto.mjs --simular  dice qué subiría, sin abrir nada
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cfg, guardar, instante, leer, RAIZ } from "./comun.mjs";
import { aprobadoPixiv, confPixiv, estadoPixiv, INTENTOS_AUTO, lotesPixiv, publicablesPixiv, VENTANA_AUTO_MS } from "./pixiv-comun.mjs";

const RUTA = join(RAIZ, "config/pixiv-auto.json");
const LOG = join(RAIZ, "config/pixiv-auto.log");
const simular = process.argv.includes("--simular");
const log = (m) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); if (!simular) appendFileSync(LOG, l + "\n"); };
const informe = (x) => { if (!simular) guardar(RUTA, { ...(existsSync(RUTA) ? leer(RUTA) : {}), ...x, revisado: new Date().toISOString() }); };

const c = cfg();
const cp = confPixiv(c);
if (!cp.activa || cp.modo !== "auto") { console.log(`Pixiv en modo "${cp.modo}": no subo nada solo.`); process.exit(0); }

const ahora = Date.now();
const todos = lotesPixiv(c).map((dir) => ({ dir, l: leer(join(dir, "lote.json")), est: estadoPixiv(dir).piezas, ok: aprobadoPixiv(dir) }));
const piezas = todos.flatMap(({ dir, l, est, ok }) => publicablesPixiv(l).map((p) => ({ ...p, dir, lote: l.lote, e: est[p.n]?.pixiv ?? null, ok })));
// Solo los de la franja en curso: llegó la hora, no pasaron los 45 minutos de reintentos, sin estado y con intentos.
const toca = piezas
  .filter((p) => {
    if (!p.ok || !p.fecha || p.e?.estado) return false;
    const ms = instante(p.fecha, p.hora, p.zona ?? cp.zona).getTime();
    return ms <= ahora && ahora <= ms + VENTANA_AUTO_MS && (p.e?.intentos ?? 0) < INTENTOS_AUTO;
  })
  .sort((a, b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`));

// Atrasados: si en esta franja no hay nada propio, se sube el
// post aprobado más viejo que no salió a su hora (PC apagada, Pixiv ocupado) en los últimos 3 días, nunca uno que ya
// tocó Post (estado FALLIDO o SUBIENDO: podría duplicarse). Uno por corrida.
if (!toca.length) toca.push(...piezas
  .filter((p) => {
    if (!p.ok || !p.fecha || p.e?.estado) return false;
    const ms = instante(p.fecha, p.hora, p.zona ?? cp.zona).getTime();
    return ms < ahora - VENTANA_AUTO_MS && ms > ahora - 3 * 86400e3 && (p.e?.intentos ?? 0) < INTENTOS_AUTO;
  })
  .sort((a, b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`))
  .slice(0, 1));
if (!toca.length) { console.log("Nada para subir en esta franja."); process.exit(0); }
const p = toca[0];
const intento = (p.e?.intentos ?? 0) + 1;
if (simular) { console.log(`Subiría ${p.lote} #${p.n} (${p.personaje}, franja ${p.fecha} ${p.hora} de Japón), intento ${intento} de ${INTENTOS_AUTO}.`); process.exit(0); }
log(`subo ${p.lote} #${p.n} (${p.personaje}, franja ${p.fecha} ${p.hora} de Japón), intento ${intento} de ${INTENTOS_AUTO}`);
// Publicar tiene prioridad: si el Chrome de Pixiv lo está usando una búsqueda del panel
// (sugerencias o concursos), se corta esa búsqueda. Si lo usa una subida o el inicio de sesión, no se toca nada:
// este intento queda anotado y se reintenta en la corrida siguiente.
const procesos = () => JSON.parse(spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='chrome.exe'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8" }).stdout || "[]");
try {
  const L = [].concat(procesos()).filter((x) => x?.CommandLine);
  const chrome = L.filter((x) => x.Name === "chrome.exe" && x.CommandLine.includes("pixiv-perfil"));
  const busquedas = L.filter((x) => x.Name === "node.exe" && /pixiv-(sugerencias|concursos|metricas)\.mjs/.test(x.CommandLine));
  const otros = L.filter((x) => x.Name === "node.exe" && /pixiv\.mjs/.test(x.CommandLine) && x.ProcessId !== process.pid);
  if (chrome.length && !otros.length && busquedas.length) {
    for (const x of [...busquedas, ...chrome]) spawnSync("taskkill", ["/PID", String(x.ProcessId), "/T", "/F"]);
    log(`corté la búsqueda de Pixiv que usaba el Chrome (${busquedas.map((x) => x.CommandLine.match(/pixiv-\w+\.mjs/)[0]).join(", ")}) para publicar`);
    await new Promise((r) => setTimeout(r, 2500));
  }
} catch (e) { log(`no pude revisar si el Chrome de Pixiv estaba ocupado: ${e.message}`); }
const { subir } = await import("./pixiv.mjs");
try {
  await subir(p.lote, p.n);
  informe({ ok: true, mensaje: null, ultimo: { lote: p.lote, n: p.n, cuando: new Date().toISOString() } });
  log("listo");
} catch (e) {
  // Si el error fue antes de tocar Post, se anota el intento (la próxima corrida reintenta mientras dure la ventana).
  const rutaEst = join(p.dir, "estado.json");
  const est = estadoPixiv(p.dir);
  const actual = est.piezas[p.n]?.pixiv ?? {};
  if (!actual.estado) { est.piezas[p.n] = { ...(est.piezas[p.n] ?? {}), pixiv: { ...actual, intentos: intento, error: e.message } }; guardar(rutaEst, est); }
  const ultimo = actual.estado || intento >= INTENTOS_AUTO;
  informe({ ok: !ultimo, mensaje: ultimo ? `El post ${p.lote} #${p.n} no salió solo (${e.message}). Quedó pendiente: subilo vos con "Subir a Pixiv".` : null });
  log(`error (intento ${intento}): ${e.message}${ultimo ? " · queda pendiente para la persona a cargo" : " · reintento en 15 minutos"}`);
  process.exit(1);
}

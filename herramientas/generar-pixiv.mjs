// Lotes de Pixiv:
//   node herramientas/generar-pixiv.mjs [--cantidad 7]
//       Lote nuevo: elige del Backlog posts de exactamente 3 imágenes del mismo personaje (sin usar en Pixiv), primero
//       los personajes con pack en Patreon, rotando entre todos; prepara las imágenes (JPG de hasta 2048 px, sin
//       metadatos, marca de agua garantizada); la IA escribe título, descripción, etiquetas y "Adult content"
//       (docs/instrucciones-pixiv.md) y otra corrida lo revisa (docs/instrucciones-revision-pixiv.md).
//   node herramientas/generar-pixiv.mjs --cambiar <lote> <n> <archivo1,archivo2,archivo3>
//       Cambia las 3 imágenes de un post (nombres de archivo del Backlog) y lo vuelve a escribir y revisar.
//   node herramientas/generar-pixiv.mjs --revisar <lote>
//       Vuelve a revisar un lote entero (sin aprobar).
// El lote queda esperando la aprobación de la persona a cargo en el panel (pestaña Pixiv).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { carpetas, cfg, guardar, hoyEn, leer, marcarImagen, pNN, RAIZ, sha256, shaArchivo } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";
import { aprobadoPixiv, asignarFechasPixiv, ETIQUETAS, confPixiv, controlarPixiv, diasOcupadosPixiv, disponiblesPixiv, dirLotesPixiv, estadoPixiv, lotesPixiv, personajeArchivo, personajesPatreon, POR_POST } from "./pixiv-comun.mjs";

const c = cfg();
const cp = confPixiv(c);
const base = dirLotesPixiv(c);
mkdirSync(base, { recursive: true });
const reparto = (q) => q.map((f, i) => [f, (i * 0.6180339887) % 1]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);

/** Elige `cantidad` grupos de 3 imágenes: todos los personajes por igual, los menos vistos antes, sin repetir seguidos. */
function elegir(cantidad) {
  const pat = personajesPatreon(c);
  const grupos = [...disponiblesPixiv(c)].map(([pj, fs]) => ({ pj, patreon: pat.has(pj), cola: reparto(fs) })).filter((g) => g.cola.length >= POR_POST);
  const ocupados = diasOcupadosPixiv(c);
  let previo = ocupados.get([...ocupados.keys()].sort().at(-1)) ?? null;
  const vistos = new Map();
  for (const d of lotesPixiv(c).slice(-3)) for (const p of leer(join(d, "lote.json")).piezas) if (!p.bloqueada) vistos.set(p.personaje, (vistos.get(p.personaje) ?? 0) + 1);
  const out = [];
  while (out.length < cantidad) {
    const libres = grupos.filter((g) => g.cola.length >= POR_POST);
    if (!libres.length) break;
    const pool = libres; // todos por igual; antes iban primero los personajes con pack en Patreon
    const opciones = pool.filter((g) => g.pj !== previo);
    const usos = (g) => out.filter((x) => x.personaje === g.pj).length * 100 + (vistos.get(g.pj) ?? 0);
    const g = (opciones.length ? opciones : pool).sort((a, b) => usos(a) - usos(b) || b.cola.length - a.cola.length)[0];
    out.push({ personaje: g.pj, patreon: g.patreon, archivos: g.cola.splice(0, POR_POST) });
    previo = g.pj;
  }
  return out;
}

/** Prepara las 3 imágenes de un post en <dir>/pNN (borra lo que hubiera). */
function preparar(dir, n, archivos) {
  const carpeta = join(dir, pNN(n));
  rmSync(carpeta, { recursive: true, force: true });
  mkdirSync(carpeta);
  return archivos.map((f, k) => {
    const salida = join(carpeta, `${k + 1}.jpg`);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", f, "-vf", "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease", "-map_metadata", "-1", "-q:v", "2", "-frames:v", "1", salida]);
    if (r.status !== 0 || !existsSync(salida)) throw new Error(`No pude preparar ${basename(f)}.`);
    marcarImagen(salida, f, c); // regla: sin marca de agua visible no se publica (las ya firmadas se reconocen por SHA-256)
    copyFileSync(f, join(carpeta, `original-${k + 1}${extname(f).toLowerCase()}`));
    return { archivo: `${pNN(n)}/${k + 1}.jpg`, archivo_original: basename(f), sha256_original: shaArchivo(f), sha256: sha256(salida) };
  });
}

const correrIA = (prompt, herramientas) => ejecutarIA(prompt, { herramientas: herramientas, dirs: [base] });

/** Redacción (solo las piezas `ns`) + revisión del lote entero + control + fechas. */
async function escribirYRevisar(dir, ns) {
  const rutaLote = join(dir, "lote.json");
  const lote = leer(rutaLote);
  const fijos = new Map(lote.piezas.map((p) => [p.n, { imagenes: p.imagenes, patreon: p.patreon }]));
  if (ns.length) {
    const anteriores = lotesPixiv(c).filter((d) => d !== dir).slice(-4).flatMap((d) => leer(join(d, "lote.json")).piezas.filter((p) => p.titulo && !p.bloqueada).map((p) => ({ titulo: p.titulo, descripcion: p.descripcion })))
      .concat(lote.piezas.filter((p) => !ns.includes(p.n) && p.titulo).map((p) => ({ titulo: p.titulo, descripcion: p.descripcion })));
    const rutaAnt = join(dir, "anteriores.json");
    guardar(rutaAnt, anteriores);
    console.log(`== Redacción de Pixiv ${lote.lote}: post(s) #${ns.join(", #")}`);
    const codigo = await correrIA([
      `Escribí los posts del lote de Pixiv ${rutaLote} siguiendo al pie de la letra ${join(RAIZ, "docs/instrucciones-pixiv.md")} (leelas primero, y también ${join(RAIZ, "docs/instrucciones-lote.md")}).`,
      `Escribí SOLO las piezas con n = ${ns.join(", ")}; no cambies las demás.`,
      `Las imágenes están en la carpeta del lote (${dir}), en imagenes[].archivo de cada pieza: abrí las 3 de cada pieza antes de escribir.`,
      `Las etiquetas posibles están en ${join(RAIZ, "docs/pixiv-etiquetas.json")}. Los títulos y descripciones que no hay que repetir están en ${rutaAnt}.`,
      `Completá personaje, titulo, descripcion, etiquetas_extra, sugerente, idea y alerta de esas piezas en ${rutaLote}. No modifiques ningún otro archivo. Al terminar respondé solo "LISTO".`,
    ].join("\n"), "Read,Write,Edit,Glob");
    if (codigo !== 0) throw new Error("La redacción no terminó.");
    const escrito = leer(rutaLote);
    for (const e of escrito.piezas) {
      Object.assign(e, fijos.get(e.n)); // la IA no puede cambiar lo que fija el sistema
      if (ns.includes(e.n) && !e.titulo && !e.alerta) throw new Error(`La pieza #${e.n} quedó sin texto.`);
    }
    guardar(rutaLote, { ...escrito, lote: lote.lote, tipo: "pixiv", piezas: escrito.piezas.filter((e) => fijos.has(e.n)) });
  }
  const rutaRev = join(dir, "revision.json");
  rmSync(rutaRev, { force: true });
  console.log(`== Revisión del lote de Pixiv ${lote.lote}`);
  const cr = await correrIA([
    `Revisá el lote de Pixiv ${rutaLote} siguiendo al pie de la letra ${join(RAIZ, "docs/instrucciones-revision-pixiv.md")} (leelas primero).`,
    `Las imágenes están en la carpeta del lote (${dir}), en imagenes[].archivo de cada pieza. Abrí las 3 de cada pieza.`,
    `Escribí el resultado únicamente en ${rutaRev}. No modifiques ningún otro archivo. Al terminar respondé solo "LISTO".`,
  ].join("\n"), "Read,Write,Glob");
  if (cr !== 0 || !existsSync(rutaRev)) throw new Error("La revisión no terminó.");
  aplicarRevision(dir);
}

/** Aplica revision.json al lote: correcciones, "Adult content", bloqueos, control automático y fechas. */
function aplicarRevision(d) {
  const rutaLote = join(d, "lote.json");
  const rev = leer(join(d, "revision.json"));
  const lote = leer(rutaLote);
  for (const p of lote.piezas) {
    const r = rev.piezas.find((x) => x.n === p.n);
    p.revision = r ? { resultado: r.resultado, observaciones: r.observaciones ?? [] } : { resultado: "sin revisar", observaciones: ["la revisión no incluyó esta pieza"] };
    if (r?.personaje_corregido) p.personaje = String(r.personaje_corregido).toLowerCase();
    if (typeof r?.sugerente === "boolean") p.sugerente = r.sugerente; // manda la revisión
    if (r?.resultado === "corregir") {
      if (r.titulo_corregido) p.titulo = r.titulo_corregido;
      if (r.descripcion_corregida) p.descripcion = r.descripcion_corregida;
      if (Array.isArray(r.etiquetas_corregidas)) p.etiquetas_extra = r.etiquetas_corregidas;
    }
    if (p.alerta && !(r?.resultado === "corregir" && r.titulo_corregido)) Object.assign(p, { bloqueada: true, motivo: `Redacción: ${p.alerta}` });
    else if (p.alerta) p.alerta = null;
    if (r?.resultado === "bloquear") Object.assign(p, { bloqueada: true, motivo: `Revisión: ${(r.observaciones ?? []).join("; ")}` });
    else if (r && p.bloqueada && /^(Revisión|Redacción|La revisión)/.test(p.motivo ?? "")) Object.assign(p, { bloqueada: false, motivo: null }); // una revisión nueva levanta su propio bloqueo
    if (!r) Object.assign(p, { bloqueada: true, motivo: "La revisión no incluyó esta pieza." });
    const prob = p.bloqueada ? [] : controlarPixiv(p);
    console.log(`#${p.n} ${p.personaje} ${p.bloqueada ? "BLOQUEADA: " + p.motivo : p.revision.resultado} · adult content: ${p.sugerente ? "Included" : "No"}${prob.length ? " · control: " + prob.join("; ") : ""}`);
  }
  lote.revisado = new Date().toISOString();
  lote.__dir = d;
  asignarFechasPixiv(lote, c);
  delete lote.__dir;
  guardar(rutaLote, lote);
}

function dirDe(nombre) {
  const d = lotesPixiv(c).find((x) => leer(join(x, "lote.json")).lote === nombre);
  if (!d) throw new Error(`No existe el lote de Pixiv ${nombre}`);
  if (aprobadoPixiv(d) || existsSync(join(d, "aprobacion.json"))) throw new Error("El lote está aprobado: anulá la aprobación en el panel antes de cambiarlo.");
  if (Object.values(estadoPixiv(d).piezas).some((e) => e.pixiv?.estado)) throw new Error("El lote ya tiene posts subidos a Pixiv.");
  return d;
}

const candado = join(base, ".generando");
if (existsSync(candado) && Date.now() - Number(readFileSync(candado, "utf8")) < 3 * 3600e3) { console.error("Ya hay un lote de Pixiv generándose."); process.exit(1); }
writeFileSync(candado, String(Date.now()));
const soltar = () => rmSync(candado, { force: true });
const modo = process.argv[2];
let nuevo = null;
try {
  if (modo === "--cambiar") {
    const [, , , nombre, nStr, lista] = process.argv;
    const d = dirDe(nombre), n = Number(nStr);
    const archivos = String(lista ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => join(carpetas(c).backlog, x));
    if (archivos.length !== POR_POST) throw new Error(`Tienen que ser exactamente ${POR_POST} imágenes.`);
    for (const f of archivos) if (!existsSync(f)) throw new Error(`No existe en el Backlog: ${basename(f)}`);
    if (new Set(archivos.map(personajeArchivo)).size !== 1) throw new Error("Las 3 imágenes tienen que ser del mismo personaje.");
    const ruta = join(d, "lote.json");
    const lote = leer(ruta);
    const p = lote.piezas.find((x) => x.n === n);
    if (!p) throw new Error(`No existe el post #${n}`);
    Object.assign(p, { imagenes: preparar(d, n, archivos), personaje: personajeArchivo(archivos[0]), etiquetas_personaje: ETIQUETAS.personajes[personajeArchivo(archivos[0])] ?? null, patreon: personajesPatreon(c).has(personajeArchivo(archivos[0])), titulo: "", descripcion: "", etiquetas_extra: [], idea: "", alerta: null, bloqueada: false, motivo: null, cambiado: new Date().toISOString() });
    guardar(ruta, lote);
    await escribirYRevisar(d, [n]);
    console.log(`Post #${n} cambiado: listo para aprobar en el panel.`);
  } else if (modo === "--revisar") {
    await escribirYRevisar(dirDe(process.argv[3]), []);
    console.log("Revisión lista.");
  } else {
    const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
    const elegidos = elegir(Number(arg("--cantidad")) || cp.posts_por_lote);
    if (!elegidos.length) throw Object.assign(new Error(`No hay ${POR_POST} imágenes sin usar en Pixiv de ningún personaje en ${carpetas(c).backlog}.`), { codigo: 2 });
    const hoy = hoyEn(cp.zona);
    let nombre = hoy;
    for (let k = 1; existsSync(join(base, nombre)); k++) nombre = `${hoy}-${String.fromCharCode(97 + k)}`;
    nuevo = join(base, nombre);
    mkdirSync(nuevo);
    const piezas = elegidos.map((g, k) => ({ n: k + 1, personaje: g.personaje, etiquetas_personaje: ETIQUETAS.personajes[g.personaje] ?? null, patreon: g.patreon, imagenes: preparar(nuevo, k + 1, g.archivos), titulo: "", descripcion: "", etiquetas_extra: [], sugerente: null, idea: "", alerta: null }));
    guardar(join(nuevo, "lote.json"), { lote: nombre, tipo: "pixiv", creado: new Date().toISOString(), marca: c.marca.nombre, piezas });
    await escribirYRevisar(nuevo, piezas.map((p) => p.n));
    guardar(join(nuevo, "estado.json"), { piezas: {} });
    console.log(`Lote de Pixiv ${nombre} listo para aprobar en el panel (pestaña Pixiv).`);
  }
  soltar();
} catch (e) {
  if (nuevo) { rmSync(nuevo, { recursive: true, force: true }); console.error("Borré el lote incompleto; las imágenes siguen en el Backlog."); }
  soltar();
  console.error(e.message);
  process.exit(e.codigo ?? 1);
}

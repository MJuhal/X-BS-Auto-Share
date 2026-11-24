// Arma un lote nuevo de punta a punta:
//   1. toma las imágenes según el origen:
//      - lote (por defecto): la carpeta Lote… más vieja (de la carpeta de entrada) con imágenes, hasta N (en orden de nombre);
//      - backlog: todas las de Backlog (hasta 30). Ese lote se aprueba una vez y sus posts
//        rellenan los días sin post (sin fecha hasta que se usan);
//      solo las que todavía no se usaron (por SHA-256 del original); las "nfw"/"nsfw" nunca entran;
//   2. las prepara (JPG de hasta 2048 px, sin metadatos) y copia el original al lote.
//      El banco de la persona a cargo no se toca: las imágenes quedan en su carpeta.
//   3. asigna el cierre de cada pieza (sin CTA, "link in bio" o link al Patreon);
//   4. la IA escribe los textos mirando cada imagen (docs/instrucciones-lote.md);
//   5. otra corrida de la IA revisa todo (revisar.mjs), corre el control automático y pone fechas.
// El lote queda esperando la aprobación de la persona a cargo en el panel.
//   node herramientas/generar.mjs [--origen lote|backlog] [--cantidad 10]
// Opciones por red:
//   --redes x|bsky|x,bsky   el lote sale solo en esas redes (con la agenda de esa red); sin esto, en las dos
//   --fuente <carpeta>      toma las imágenes de esa carpeta (p. ej. Personajes LOL/Akali/SFW) en vez del Backlog
//   --elegir a.png,b.png    de la fuente, exactamente esos archivos y en ese orden
//   --extra <carpeta>=<n>   suma n imágenes de otra carpeta (el resto sale de la fuente o del Backlog)
//   --patreon               del Backlog, primero los personajes con pack en Patreon
//   --ctas patreon:0,bio:3  cuántos cierres de cada tipo (el resto, sin invitación)
//   --contexto "..."        nota para la redacción (p. ej. "semana dedicada a un solo personaje")
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { carpetas, carpetasLote, cfg, guardar, hoyEn, imagenes, leer, lotes, marcarImagen, pendientes, pNN, prohibidaPorNombre, RAIZ, sha256, shaArchivo } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";
import { revisar } from "./revisar.mjs";
import { personajesPatreon } from "./pixiv-comun.mjs";

/** Del Backlog se toman imágenes de varios personajes, intercaladas (el personaje sale del nombre del
 *  archivo, "<campeón>-sfw-cute-N"), así el lote puede alternar y no repetir dos posts seguidos. */
function rotarPersonajes(lista, primero = null) {
  const grupos = new Map();
  for (const f of lista) { const k = basename(f).toLowerCase().split("-")[0]; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(f); }
  // Dentro de cada personaje se reparten las elegidas a lo largo de la lista (las consecutivas suelen
  // ser de la misma sesión y con poses parecidas): 0, mitad, cuarto, tres cuartos...
  const repartir = (q) => q.map((f, i) => [f, ((i * 0.6180339887) % 1)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  const intercalar = (gs) => {
    const colas = gs.map(repartir).sort((a, b) => b.length - a.length);
    const out = [];
    while (colas.some((q) => q.length)) for (const q of colas) if (q.length) out.push(q.shift());
    return out;
  };
  // Todos los personajes del Backlog por igual ( Irelia, Kayle, Sona... ya se usan aunque no tengan
  // pack en Patreon; antes iban primero los que tenían pack).
  // --patreon: primero los personajes con pack en Patreon, después el resto.
  if (primero) {
    const [si, no] = [[...grupos].filter(([k]) => primero.has(k)).map(([, v]) => v), [...grupos].filter(([k]) => !primero.has(k)).map(([, v]) => v)];
    return [...intercalar(si), ...intercalar(no)];
  }
  return intercalar([...grupos.values()]);
}

const c = cfg();
const dirs = carpetas(c);
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
// Origen de las imágenes: una carpeta "Lote…" que armó la persona a cargo, o el Backlog (la reserva).
// Desde el 2026-11-17 todo lo que se arma es un Lote de 10 con fechas fijas que la persona a cargo aprueba
//.
const fuenteArg = arg("--fuente");
const origen = fuenteArg || arg("--origen") === "backlog" ? "backlog" : "carpeta";
const redesArg = arg("--redes") ? arg("--redes").split(",").map((x) => x.trim()).filter((x) => ["x", "bsky"].includes(x)) : null;
const elegirArg = arg("--elegir") ? arg("--elegir").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : null;
const extraArg = arg("--extra") ? (([d, n]) => ({ dir: d, n: Number(n) || 0 }))(arg("--extra").split(/=(?=\d+$)/)) : null;
const ctasArg = arg("--ctas") ? Object.fromEntries(arg("--ctas").split(",").map((x) => x.split(":")).map(([k, v]) => [k.trim(), Number(v) || 0])) : null;
const contexto = arg("--contexto");
const conPatreon = process.argv.includes("--patreon") ? personajesPatreon(c) : null;
const tipo = "lote";
const cantidad = Number(arg("--cantidad")) || c.lote.cantidad;
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

// Un solo lote a la vez.
const candado = join(dirs.base, ".generando");
if (existsSync(candado) && Date.now() - Number(readFileSync(candado, "utf8")) < 3 * 3600e3) {
  console.error("Ya hay un lote generándose.");
  process.exit(1);
}
writeFileSync(candado, String(Date.now()));
const soltar = () => rmSync(candado, { force: true });
let dir = null;
const piezas = [];

try {
  const fuente = fuenteArg || (origen === "backlog" ? dirs.backlog : carpetasLote(c)[0]);
  // Lo marcado como no apto ("nfw"/"nsfw") nunca entra (queda en su carpeta, no se toca).
  for (const f of fuente ? imagenes(fuente) : []) if (prohibidaPorNombre(f)) console.log(`${basename(f)}: marcada como no apta para X, la salteo.`);
  const disponibles = fuente ? pendientes(fuente, c) : [];
  const extra = extraArg ? rotarPersonajes(pendientes(extraArg.dir, c)).slice(0, extraArg.n).map((f) => ({ f, origen, carpeta_origen: extraArg.dir })) : [];
  if (extraArg && extra.length < extraArg.n) console.log(`${extraArg.dir}: pedí ${extraArg.n} y solo hay ${extra.length} sin usar.`);
  const base = elegirArg
    ? elegirArg.map((n) => disponibles.find((f) => basename(f).toLowerCase() === n) ?? (console.log(`${n}: no está o ya se usó, la salteo.`), null)).filter(Boolean)
    : origen === "backlog" ? rotarPersonajes(disponibles, conPatreon) : disponibles;
  const propias = base.slice(0, Math.max(0, cantidad - extra.length)).map((f) => ({ f, origen, carpeta_origen: fuente }));
  // Mezcla: se intercalan las de la fuente y las extra (así la redacción y las fechas alternan desde el principio).
  const elegidas = [];
  for (let k = 0; k < Math.max(propias.length, extra.length); k++) { if (extra[k]) elegidas.push(extra[k]); if (propias[k]) elegidas.push(propias[k]); }
  if (!elegidas.length) {
    console.error(origen === "backlog" ? `No hay imágenes sin usar en ${dirs.backlog}.` : `No hay carpetas "Lote…" con imágenes en ${dirs.nuevas}.`);
    soltar();
    process.exit(2);
  }

  // Nombre del lote: fecha de hoy (y una letra si ya hay uno ese día).
  const hoy = hoyEn(c.publicacion.zona);
  let nombre = hoy;
  const raiz = nombre;
  for (let k = 1; existsSync(join(dirs.lotes, nombre)); k++) nombre = `${raiz}-${String.fromCharCode(97 + k)}`;
  dir = join(dirs.lotes, nombre);
  mkdirSync(dir);

  // Preparar imágenes.
  for (const { f, origen, carpeta_origen } of elegidas) {
    const n = piezas.length + 1;
    const carpeta = join(dir, pNN(n));
    mkdirSync(carpeta);
    const salida = join(carpeta, "imagen.jpg");
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", f, "-vf", "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease", "-map_metadata", "-1", "-q:v", "2", "-frames:v", "1", salida]);
    if (r.status !== 0 || !existsSync(salida)) {
      rmSync(carpeta, { recursive: true, force: true });
      const rutaRech = join(dirs.base, "rechazadas.json");
      const rech = existsSync(rutaRech) ? leer(rutaRech) : [];
      rech.push({ archivo: f, sha256: shaArchivo(f), motivo: "no se pudo leer la imagen", fecha: new Date().toISOString() });
      guardar(rutaRech, rech);
      console.log(`${basename(f)}: no se pudo leer la imagen; queda en su carpeta y no se vuelve a intentar (rechazadas.json).`);
      continue;
    }
    marcarImagen(salida, f, c); // marca de agua (las que ya la traen se reconocen por config)
    const sha256_original = shaArchivo(f);
    copyFileSync(f, join(carpeta, `original${extname(f).toLowerCase()}`));
    piezas.push({ n, imagen: `${pNN(n)}/imagen.jpg`, archivo_original: basename(f), origen, carpeta_origen, sha256_original, sha256: sha256(salida) });
  }
  if (!piezas.length) throw new Error("Ninguna imagen se pudo preparar.");

  // Cierres repartidos a lo largo del lote: link al Patreon, "link in bio" y sin CTA.
  const N = piezas.length;
  const ctas = Array(N).fill("ninguno");
  const repartir = (cuantas, valor) => {
    const libres = ctas.map((v, k) => (v === "ninguno" ? k : -1)).filter((k) => k >= 0);
    for (let k = 0; k < Math.min(cuantas, libres.length); k++) ctas[libres[Math.floor(((k + 0.5) * libres.length) / cuantas)]] = valor;
  };
  repartir(ctasArg ? ctasArg.patreon ?? 0 : Math.round((c.lote.con_link_patreon * N) / c.lote.cantidad), "patreon");
  repartir(ctasArg ? ctasArg.bio ?? 0 : Math.round((c.lote.con_link_in_bio * N) / c.lote.cantidad), "bio");
  // Estrategia de volumen: todos los posts invitan al perfil o al Patreon (aunque sea indirecto).
  // Con --ctas manda lo pedido.
  if (c.lote.siempre_cta && !ctasArg) ctas.forEach((v, k) => { if (v === "ninguno") ctas[k] = "bio"; });
  piezas.forEach((p, k) => Object.assign(p, { cta: ctas[k], personaje: "", texto: "", alt: "", idea: "", alerta: null }));

  const rutaLote = join(dir, "lote.json");
  guardar(rutaLote, { lote: nombre, tipo, creado: new Date().toISOString(), marca: c.marca.nombre, ...(redesArg?.length ? { redes: redesArg } : {}), ...(contexto ? { contexto } : {}), piezas });

  // Textos anteriores, para que no se repitan.
  const anteriores = lotes(c).filter((d) => d !== dir).slice(-8)
    .flatMap((d) => leer(join(d, "lote.json")).piezas.filter((p) => p.texto && !p.bloqueada).map((p) => p.texto));
  const rutaAnteriores = join(dir, "anteriores.json");
  guardar(rutaAnteriores, anteriores);

  const prompt = [
    `Escribí los posts del lote ${rutaLote} siguiendo al pie de la letra ${join(RAIZ, "docs/instrucciones-lote.md")} (leelas primero).`,
    `Las imágenes están en la carpeta del lote (${dir}), en la ruta "imagen" de cada pieza: abrí cada una antes de escribir su texto.`,
    `Los textos de los posts anteriores (para no repetir ganchos ni cierres) están en ${rutaAnteriores}.`,
    ...(redesArg?.length ? [`Este lote sale solo en ${redesArg.map((r) => (r === "x" ? "X" : "Bluesky")).join(" y ")}.`] : []),
    ...(contexto ? [`Contexto de este lote (de la persona a cargo): ${contexto}`] : []),
    `Completá personaje, texto, alt, idea y alerta de cada pieza en ${rutaLote}. No modifiques ningún otro archivo. Al terminar respondé solo "LISTO".`,
  ].join("\n");
  console.log(`== Redacción del lote ${nombre} (${N} piezas)`);
  const codigo = await ejecutarIA(prompt, { herramientas: "Read,Write,Edit,Glob", dirs: [carpetas(c).lotes] });
  if (codigo !== 0) throw new Error("La redacción no terminó.");

  // la IA no puede cambiar lo que fija el sistema.
  const escrito = leer(rutaLote);
  for (const p of piezas) {
    const e = escrito.piezas.find((x) => x.n === p.n);
    if (!e) throw new Error(`La redacción borró la pieza #${p.n}.`);
    Object.assign(e, { imagen: p.imagen, cta: p.cta, sha256: p.sha256, sha256_original: p.sha256_original, origen: p.origen, carpeta_origen: p.carpeta_origen, archivo_original: p.archivo_original });
    if (!e.texto && !e.alerta) throw new Error(`La pieza #${p.n} quedó sin texto.`);
  }
  guardar(rutaLote, { ...escrito, lote: nombre, tipo, ...(redesArg?.length ? { redes: redesArg } : {}), piezas: escrito.piezas.filter((e) => piezas.some((p) => p.n === e.n)) });

  await revisar(dir);
  guardar(join(dir, "estado.json"), { piezas: {} });
  console.log(`Lote ${nombre} listo para aprobar en el panel.`);
  soltar();
} catch (e) {
  // Si algo falló, se borra el lote incompleto (las imágenes nunca salieron de su carpeta).
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    console.error("Borré el lote incompleto; las imágenes siguen disponibles en su carpeta.");
  }
  soltar();
  console.error(e.message);
  process.exit(1);
}

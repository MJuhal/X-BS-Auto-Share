// Cambiar la imagen de UN post de un lote ya armado, en X/Bluesky o
// en Pixiv, aunque el lote esté aprobado, con posts en Buffer o con posts ya publicados en Pixiv.
//   - Solo toca ese post: las fechas y los demás posts del lote quedan igual (aprobar o revisar el lote entero
//     recalcula fechas y no se puede hacer con posts ya programados o publicados).
//   - Prepara la imagen nueva como el generador (JPG de hasta 2048 px, sin metadatos, con marca de agua), redacta el
//     texto con docs/instrucciones-lote.md (o -pixiv.md) y lo revisa con las instrucciones de revisión, solo ese post.
//   - Todo se prepara aparte (pNN/_nuevo y archivos cambio-*): Buffer y el lote se tocan recién al final, si la
//     redacción y la revisión salieron bien. Si algo falla antes, el lote queda como estaba.
//   - X/Bluesky: si el post estaba programado en Buffer, lo saca de la cola (la próxima programación sube el nuevo).
//   - Si el lote estaba aprobado, la aprobación se renueva con el cambio anotado (quién lo pidió, cuándo y por qué):
//     el cambio lo pide la persona a cargo al correr esto. Si la revisión bloquea el post nuevo, queda bloqueado y se avisa.
//   - Con --motivo, las imágenes reemplazadas quedan en rechazadas.json (no vuelven a elegirse nunca).
//   node herramientas/cambiar-post.mjs x <lote> <n> <archivo-del-backlog> [--motivo "texto"]
//   node herramientas/cambiar-post.mjs pixiv <lote> <n> <a.png,b.png,c.png> [--motivo "texto"]
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { carpetas, cfg, controlar, estadoDe, guardar, huellaLote, leer, lotes, marcarImagen, personajeExcluido, pNN, prohibidaPorNombre, RAIZ, sha256, shaArchivo } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";
import { controlarPixiv, dirLotesPixiv, ETIQUETAS, estadoPixiv, huellaPixiv, lotesPixiv, personajeArchivo, personajesPatreon, POR_POST } from "./pixiv-comun.mjs";

const c = cfg();
const [red, nombre, nStr, lista] = process.argv.slice(2);
const iMot = process.argv.indexOf("--motivo");
const motivo = iMot > 0 ? process.argv[iMot + 1] : null;
const n = Number(nStr);
const pixiv = red === "pixiv";
if (!["x", "pixiv"].includes(red) || !nombre || !n || !lista) {
  console.error('Uso: node herramientas/cambiar-post.mjs x|pixiv <lote> <n> <archivo(s) del Backlog> [--motivo "texto"]');
  process.exit(1);
}
const backlog = carpetas(c).backlog;
const ffmpeg = (f, salida) => {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", f, "-vf", "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease", "-map_metadata", "-1", "-q:v", "2", "-frames:v", "1", salida]);
  if (r.status !== 0 || !existsSync(salida)) throw new Error(`No pude preparar ${basename(f)}.`);
  marcarImagen(salida, f, c);
};
const correrIA = (prompt, herramientas, dir) => ejecutarIA(prompt, { herramientas: herramientas, dirs: [dir] });
async function sacarDeBuffer(dir) {
  const est = estadoDe(dir);
  const e = est.piezas[n] ?? {};
  const claves = leer(c.publicacion.publicador);
  for (const [k, r] of Object.entries(e)) {
    if (r?.estado !== "PROGRAMADO" || !r.buffer_id) continue;
    const resp = await fetch("https://api.buffer.com", {
      method: "POST",
      headers: { Authorization: `Bearer ${claves.buffer_api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "mutation($i: DeletePostInput!) { deletePost(input: $i) { __typename ... on VoidMutationError { message } } }", variables: { i: { id: r.buffer_id } } }),
    });
    const j = await resp.json().catch(() => ({}));
    const d = j.data?.deletePost;
    if (!resp.ok || j.errors || d?.__typename !== "DeletePostSuccess") throw new Error(`No pude sacar el post de Buffer (${k}): ${d?.message ?? JSON.stringify(j.errors ?? j).slice(0, 200)}. El lote quedó como estaba.`);
    delete e[k];
    est.piezas[n] = e;
    guardar(join(dir, "estado.json"), est); // por red: si la segunda falla, la primera ya quedó registrada
    console.log(`Saqué de Buffer el post #${n} [${k}] (salía ${r.dueAt}).`);
  }
  delete est.piezas[n];
  guardar(join(dir, "estado.json"), est);
}

let tmp = null, temporales = [];
try {
  const dir = (pixiv ? lotesPixiv(c) : lotes(c)).find((d) => leer(join(d, "lote.json")).lote === nombre);
  if (!dir) throw new Error(`No existe el lote ${nombre}.`);
  const rutaLote = join(dir, "lote.json");
  const lote = leer(rutaLote);
  const p = lote.piezas.find((x) => x.n === n);
  if (!p) throw new Error(`No existe el post #${n} en ${nombre}.`);
  const archivos = String(lista).split(",").map((x) => join(backlog, x.trim()));
  for (const f of archivos) {
    if (!existsSync(f)) throw new Error(`No existe en el Backlog: ${basename(f)}`);
    if (prohibidaPorNombre(f)) throw new Error(`${basename(f)} está marcada como no apta.`);
    if (personajeExcluido(f, c)) throw new Error(`${basename(f)} es de un personaje excluido (config personajes_excluidos).`);
  }
  const rutaAprob = join(dir, "aprobacion.json");
  const huella = pixiv ? huellaPixiv : huellaLote;
  const estabaAprobado = existsSync(rutaAprob) && leer(rutaAprob).huella === huella(dir);

  // 1) Que el post no haya salido.
  if (pixiv) {
    const e = estadoPixiv(dir).piezas[n]?.pixiv?.estado;
    if (["PUBLICADO", "SUBIENDO", "PROGRAMADO"].includes(e)) throw new Error(`El post #${n} ya está en Pixiv (${e}): no se puede cambiar.`);
    if (archivos.length !== POR_POST) throw new Error(`En Pixiv son exactamente ${POR_POST} imágenes.`);
    if (new Set(archivos.map(personajeArchivo)).size !== 1) throw new Error("Las 3 imágenes tienen que ser del mismo personaje.");
  } else {
    if (archivos.length !== 1) throw new Error("En X es una sola imagen.");
    if (Object.values(estadoDe(dir).piezas[n] ?? {}).some((r) => r?.estado === "PUBLICADO")) throw new Error(`El post #${n} ya se publicó en alguna red: no se puede cambiar.`);
  }

  // 2) Imágenes nuevas, en una carpeta aparte. `nuevo` es la versión del post que se arma sin tocar el lote.
  const carpeta = join(dir, pNN(n));
  tmp = join(carpeta, "_nuevo");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const nuevo = structuredClone(p);
  let viejas;
  if (pixiv) {
    viejas = (p.imagenes ?? []).map((i) => ({ archivo: join(backlog, i.archivo_original), sha256: i.sha256_original }));
    nuevo.imagenes = archivos.map((f, k) => {
      const salida = join(tmp, `${k + 1}.jpg`);
      ffmpeg(f, salida);
      copyFileSync(f, join(tmp, `original-${k + 1}${extname(f).toLowerCase()}`));
      return { archivo: `${pNN(n)}/_nuevo/${k + 1}.jpg`, archivo_original: basename(f), sha256_original: shaArchivo(f), sha256: sha256(salida) };
    });
    Object.assign(nuevo, { personaje: personajeArchivo(archivos[0]), etiquetas_personaje: ETIQUETAS.personajes[personajeArchivo(archivos[0])] ?? null, patreon: personajesPatreon(c).has(personajeArchivo(archivos[0])), titulo: "", descripcion: "", etiquetas_extra: [], idea: "", alerta: null, bloqueada: false, motivo: null });
  } else {
    viejas = [{ archivo: join(p.carpeta_origen ?? backlog, p.archivo_original ?? ""), sha256: p.sha256_original }];
    const f = archivos[0];
    const salida = join(tmp, "imagen.jpg");
    ffmpeg(f, salida);
    copyFileSync(f, join(tmp, `original${extname(f).toLowerCase()}`));
    Object.assign(nuevo, { imagen: `${pNN(n)}/_nuevo/imagen.jpg`, archivo_original: basename(f), origen: "backlog", carpeta_origen: backlog, sha256_original: shaArchivo(f), sha256: sha256(salida), personaje: "", texto: "", alt: "", idea: "", alerta: null, bloqueada: false, motivo: null });
  }
  nuevo.cambiado = { fecha: new Date().toISOString(), motivo: motivo ?? "cambio de imagen" };

  // 3) Redacción y revisión de ESE post (en un archivo aparte, para que nada toque al resto del lote).
  const rutaCambio = join(dir, `cambio-${pNN(n)}.json`);
  const rutaRev = join(dir, `cambio-${pNN(n)}-revision.json`);
  const rutaAnt = join(dir, `cambio-${pNN(n)}-anteriores.json`);
  temporales = [rutaCambio, rutaRev, rutaAnt];
  const anteriores = (pixiv ? lotesPixiv(c) : lotes(c)).slice(-8).flatMap((d) => leer(join(d, "lote.json")).piezas.map((x) => ({ ...x, __d: d })))
    .filter((x) => !(x.__d === dir && x.n === n) && !x.bloqueada && (pixiv ? x.titulo : x.texto)).map((x) => (pixiv ? { titulo: x.titulo, descripcion: x.descripcion } : x.texto));
  guardar(rutaAnt, anteriores);
  guardar(rutaCambio, { lote: lote.lote, tipo: lote.tipo, piezas: [nuevo] });
  const instr = join(RAIZ, pixiv ? "docs/instrucciones-pixiv.md" : "docs/instrucciones-lote.md");
  const campos = pixiv ? "personaje, titulo, descripcion, etiquetas_extra, sugerente, idea y alerta" : "personaje, texto, alt, idea y alerta";
  const dondeImg = pixiv ? "imagenes[].archivo" : 'la ruta "imagen"';
  console.log(`== Redacción del post #${n}`);
  if (await correrIA([
    `Escribí el post del archivo ${rutaCambio} siguiendo al pie de la letra ${instr} (leelas primero${pixiv ? `, y también ${join(RAIZ, "docs/instrucciones-lote.md")}` : ""}).`,
    `Las imágenes están en la carpeta ${dir}, en ${dondeImg} de la pieza: abrilas antes de escribir.`,
    pixiv ? `Las etiquetas posibles están en ${join(RAIZ, "docs/pixiv-etiquetas.json")}.` : "Respetá el cta que trae la pieza.",
    `Los textos que no hay que repetir están en ${rutaAnt}.`,
    `Completá ${campos} en ${rutaCambio}. No modifiques ningún otro archivo. Al terminar respondé solo "LISTO".`,
  ].join("\n"), "Read,Write,Edit", dir) !== 0) throw new Error("La redacción no terminó. El lote quedó como estaba.");
  const escrito = leer(rutaCambio).piezas?.[0];
  if (!escrito) throw new Error("La redacción borró el post. El lote quedó como estaba.");
  for (const k of pixiv ? ["personaje", "titulo", "descripcion", "etiquetas_extra", "sugerente", "idea", "alerta"] : ["personaje", "texto", "alt", "idea", "alerta"]) if (k in escrito) nuevo[k] = escrito[k];
  if (pixiv && nuevo.personaje) nuevo.personaje = String(nuevo.personaje).toLowerCase();

  console.log(`== Revisión del post #${n}`);
  rmSync(rutaRev, { force: true });
  guardar(rutaCambio, { lote: lote.lote, tipo: lote.tipo, piezas: [nuevo] });
  const instrRev = join(RAIZ, pixiv ? "docs/instrucciones-revision-pixiv.md" : "docs/instrucciones-revision.md");
  if (await correrIA([
    `Revisá el lote ${rutaCambio} (tiene un solo post) siguiendo al pie de la letra ${instrRev} (leelas primero, y también ${join(RAIZ, "docs/instrucciones-lote.md")}).`,
    `Las imágenes están en la carpeta ${dir}, en ${dondeImg} de la pieza. Abrilas.`,
    `Escribí el resultado únicamente en ${rutaRev}. No modifiques ningún otro archivo. Al terminar respondé solo "LISTO".`,
  ].join("\n"), "Read,Write", dir) !== 0 || !existsSync(rutaRev)) throw new Error("La revisión no terminó. El lote quedó como estaba.");
  const r = (leer(rutaRev).piezas ?? []).find((x) => x.n === n);
  nuevo.revision = r ? { resultado: r.resultado, observaciones: r.observaciones ?? [] } : { resultado: "sin revisar", observaciones: ["la revisión no incluyó este post"] };
  if (r?.personaje_corregido) nuevo.personaje = pixiv ? String(r.personaje_corregido).toLowerCase() : r.personaje_corregido;
  if (r?.resultado === "corregir") {
    if (pixiv) {
      if (r.titulo_corregido) nuevo.titulo = r.titulo_corregido;
      if (r.descripcion_corregida) nuevo.descripcion = r.descripcion_corregida;
      if (Array.isArray(r.etiquetas_corregidas)) nuevo.etiquetas_extra = r.etiquetas_corregidas;
    } else {
      if (r.texto_corregido) nuevo.texto = r.texto_corregido;
      if (r.alt_corregido) nuevo.alt = r.alt_corregido;
    }
  }
  if (pixiv && typeof r?.sugerente === "boolean") nuevo.sugerente = r.sugerente;
  if (nuevo.alerta) Object.assign(nuevo, { bloqueada: true, motivo: `Redacción: ${nuevo.alerta}` });
  if (r?.resultado === "bloquear") Object.assign(nuevo, { bloqueada: true, motivo: `Revisión: ${(r.observaciones ?? []).join("; ")}` });
  if (!r) Object.assign(nuevo, { bloqueada: true, motivo: "La revisión no incluyó este post." });
  if (nuevo.bloqueada) throw new Error(`El post nuevo no pasó: ${nuevo.motivo}. El lote quedó como estaba: probá con otra imagen.`);
  const problemas = pixiv ? controlarPixiv(nuevo) : controlar(nuevo, c, { lote: lote.lote });
  if (problemas.length) throw new Error(`El texto nuevo tiene problemas (${problemas.join("; ")}). El lote quedó como estaba: volvé a correrlo.`);
  if (!pixiv) nuevo.problemas = [];

  // 4) Recién ahora: sacar de Buffer (X), poner las imágenes en su lugar, guardar, rechazar las viejas y renovar la
  // aprobación (con el cambio anotado).
  if (!pixiv) await sacarDeBuffer(dir);
  for (const f of readdirSync(carpeta)) if (f !== "_nuevo") rmSync(join(carpeta, f), { recursive: true, force: true });
  for (const f of readdirSync(tmp)) copyFileSync(join(tmp, f), join(carpeta, f));
  rmSync(tmp, { recursive: true, force: true });
  tmp = null;
  if (pixiv) nuevo.imagenes = nuevo.imagenes.map((i) => ({ ...i, archivo: i.archivo.replace("/_nuevo/", "/") }));
  else nuevo.imagen = `${pNN(n)}/imagen.jpg`;
  lote.piezas[lote.piezas.indexOf(p)] = nuevo;
  guardar(rutaLote, lote);
  if (motivo) {
    const ruta = pixiv ? join(dirLotesPixiv(c), "rechazadas.json") : join(carpetas(c).base, "rechazadas.json");
    const rech = existsSync(ruta) ? leer(ruta) : [];
    const ya = new Set(rech.map((x) => x.sha256));
    for (const v of viejas) if (v.sha256 && !ya.has(v.sha256)) rech.push({ archivo: v.archivo, sha256: v.sha256, motivo, fecha: new Date().toISOString() });
    guardar(ruta, rech);
  }
  if (estabaAprobado) {
    const a = leer(rutaAprob);
    guardar(rutaAprob, { ...a, huella: huella(dir), cambios: [...(a.cambios ?? []), { n, fecha: new Date().toISOString(), motivo: motivo ?? "cambio de imagen", pedido_por: "la persona a cargo" }] });
    console.log("La aprobación del lote sigue vigente (cambio anotado en aprobacion.json).");
  }
  console.log(`\nPost #${n} de ${nombre} cambiado (${nuevo.revision.resultado}).`);
  console.log(pixiv ? `Título: ${nuevo.titulo}\n${nuevo.descripcion}` : `Texto: ${nuevo.texto}`);
  console.log(`Idea: ${nuevo.idea}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const f of temporales) rmSync(f, { force: true });
}

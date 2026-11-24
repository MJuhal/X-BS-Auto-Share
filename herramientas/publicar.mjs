// Programa en X y en Bluesky (por Buffer) los posts de los lotes aprobados. Los lotes de antes se replican igual en las dos
// redes; desde 2026-11-23 un lote puede fijar "redes" (["x"] o ["bsky"]) y sale solo ahí, con la agenda de esa red.
//   node herramientas/publicar.mjs            programa lo que falta
//   node herramientas/publicar.mjs --simular  muestra qué haría, sin subir nada
//   node herramientas/publicar.mjs --canales  lista los canales de Buffer (solo lectura)
//   node herramientas/publicar.mjs --estado   solo actualiza qué ya salió (solo lectura en Buffer)
//   node herramientas/publicar.mjs --metricas [--forzar]  trae las métricas de lo publicado (solo lectura)
//
// Antes de subir cada post verifica:
//   - que el lote tenga aprobacion.json y que su huella coincida con el lote actual;
//   - que la imagen sea la aprobada (SHA-256) y que el texto pase el control automático.
// Si algo no coincide, ese post no se sube en ninguna red. Solo publica en los canales fijados en la config
// (cuentas de marca "la marca", la cuenta de la marca en X y la de Bluesky).
// El estado de cada red se guarda por separado en estado.json: piezas[n].x y piezas[n].bsky.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, controlar, estadoDe, guardar, huellaLote, idPieza, instante, leer, leerClaves, lotes, pNN, publicables, prohibidaPorNombre, redes, redesLote, rellenarConBacklog, sha256, textoBsky, textoFinal, textoX } from "./comun.mjs";

const c = cfg();
const pub = c.publicacion;
const claves = leerClaves();
const simular = process.argv.includes("--simular");
const MARGEN_MS = 10 * 60e3;
const CLAVES = ["x", "bsky"];
const LIMITE_BSKY = 950e3; // Bluesky acepta imágenes de hasta ~1 MB

async function buffer(query, variables = {}) {
  const r = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: { Authorization: `Bearer ${claves.buffer_api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`Buffer ${r.status}: ${JSON.stringify(j.errors ?? j).slice(0, 400)}`);
  return j.data;
}

async function canales() {
  const { account } = await buffer("query { account { organizations { id name } } }");
  const out = [];
  for (const o of account.organizations) {
    const { channels } = await buffer("query($i: ChannelsInput!) { channels(input: $i) { id name service displayName externalLink isDisconnected } }", { i: { organizationId: o.id } });
    out.push(...channels);
  }
  return out;
}

/** Canal autorizado de una red: solo el ID fijado en la config, del servicio esperado y de la cuenta esperada
 *  (en X por nombre; en Bluesky por el DID, que no cambia aunque se cambie el nombre visible). */
function canalDe(red, todos) {
  const k = red.canal;
  const ch = todos.find((x) => x.id === k.buffer_id);
  if (!ch) throw new Error(`${red.nombre}: el canal autorizado (${k.buffer_id}) no está conectado a Buffer.`);
  const cuenta = k.did ? (ch.externalLink ?? "").endsWith(`/${k.did}`) : ch.name.toLowerCase() === k.nombre.toLowerCase();
  if (ch.service !== k.servicio || !cuenta) throw new Error(`${red.nombre}: el ID ${ch.id} ahora es "${ch.name}" (${ch.service}), no la cuenta autorizada: no publico.`);
  if (ch.isDisconnected) throw new Error(`${red.nombre}: el canal ${ch.name} está desconectado en Buffer: hay que reconectarlo.`);
  return ch;
}

/** Imagen para Bluesky: la aprobada; si pesa más de ~1 MB, una copia recomprimida (misma imagen, menos calidad JPG). */
function imagenBsky(ruta) {
  if (statSync(ruta).size <= LIMITE_BSKY) return ruta;
  const salida = ruta.replace(/imagen\.jpg$/, "imagen-bsky.jpg");
  for (const q of [4, 6, 8, 11]) {
    spawnSync("ffmpeg", ["-v", "error", "-y", "-i", ruta, "-q:v", String(q), "-frames:v", "1", salida]);
    if (existsSync(salida) && statSync(salida).size <= LIMITE_BSKY) return salida;
  }
  throw new Error("la imagen pesa más de 1 MB y no pude achicarla para Bluesky");
}

/** Sube la imagen a Supabase (bucket público) y devuelve la URL que lee Buffer. */
async function subir(ruta, destino) {
  const datos = readFileSync(ruta);
  const publica = `${claves.supabase_url}/storage/v1/object/public/${claves.supabase_bucket}/${destino}`;
  if (!(await fetch(publica, { method: "HEAD" })).ok) {
    const r = await fetch(`${claves.supabase_url}/storage/v1/object/${claves.supabase_bucket}/${destino}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${claves.supabase_secret_key}`, apikey: claves.supabase_secret_key, "Content-Type": "image/jpeg", "x-upsert": "false" },
      body: datos,
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  const v = await fetch(publica, { method: "HEAD" });
  if (!v.ok || +v.headers.get("content-length") !== datos.length) throw new Error(`La URL pública no responde bien: ${publica}`);
  return publica;
}

/** Consulta en Buffer lo programado y marca como PUBLICADO (con el link) lo que ya salió, en cada red. */
async function sincronizar() {
  for (const dir of lotes(c)) {
    const ruta = join(dir, "estado.json");
    if (!existsSync(ruta)) continue;
    const estado = leer(ruta);
    let cambios = false;
    for (const [n, e] of Object.entries(estado.piezas)) for (const k of CLAVES) {
      const r = e[k];
      if (r?.estado !== "PROGRAMADO" || Date.parse(r.dueAt) > Date.now()) continue;
      const { post } = await buffer("query($i: PostInput!) { post(input: $i) { status sentAt externalLink error { message } } }", { i: { id: r.buffer_id } });
      if (post?.status === "sent") {
        Object.assign(r, { estado: "PUBLICADO", enviado: post.sentAt, link: post.externalLink });
        cambios = true;
        console.log(`${idPieza(leer(join(dir, "lote.json")).lote, +n)} [${k}] PUBLICADO · ${post.externalLink}`);
      } else if (post?.status === "error") {
        Object.assign(r, { estado: "FALLIDO", error: post.error?.message ?? "error en Buffer" });
        cambios = true;
        console.log(`#${n} [${k}] FALLIDO · ${r.error}`);
      }
    }
    if (cambios) guardar(ruta, estado);
  }
}

/** Trae de Buffer las métricas de los posts publicados (lo que cada red entregue).
 *  Solo consulta los de los últimos 30 días y como mucho una vez cada 6 horas por post (o siempre con --forzar). */
async function metricas() {
  const forzar = process.argv.includes("--forzar");
  for (const dir of lotes(c)) {
    const ruta = join(dir, "estado.json");
    if (!existsSync(ruta)) continue;
    const estado = leer(ruta);
    let cambios = false;
    for (const [n, e] of Object.entries(estado.piezas)) for (const k of CLAVES) {
      const r = e[k];
      if (r?.estado !== "PUBLICADO") continue;
      if (Date.now() - Date.parse(r.enviado) > 30 * 86400e3) continue;
      if (!forzar && r.metricas_consultadas && Date.now() - Date.parse(r.metricas_consultadas) < 6 * 3600e3) continue;
      const { post } = await buffer("query($i: PostInput!) { post(input: $i) { metricsUpdatedAt metrics { type value unit } } }", { i: { id: r.buffer_id } });
      r.metricas = Object.fromEntries((post?.metrics ?? []).map((m) => [m.type, m.value]));
      r.metricas_al = post?.metricsUpdatedAt ?? null;
      r.metricas_consultadas = new Date().toISOString();
      cambios = true;
      console.log(`#${n} [${k}] métricas: ${JSON.stringify(r.metricas)}`);
    }
    if (cambios) guardar(ruta, estado);
  }
}

async function main() {
  if (process.argv.includes("--metricas")) {
    await sincronizar();
    await metricas();
    return;
  }
  if (process.argv.includes("--canales")) {
    for (const ch of await canales()) console.log(`${ch.service.padEnd(10)} ${ch.name} (${ch.id})${ch.isDisconnected ? " DESCONECTADO" : ""}`);
    return;
  }
  await sincronizar();
  if (process.argv.includes("--estado")) return;
  const todos = await canales();
  const activas = [];
  for (const red of redes(c)) {
    try { activas.push({ ...red, ch: canalDe(red, todos) }); }
    catch (e) { console.log(e.message); process.exitCode = 1; } // una red caída no frena a la otra
  }
  if (!activas.length) return;
  // Días sin post (hoy, si llega, y mañana): se rellenan con el backlog ya aprobado.
  if (!simular) for (const h of rellenarConBacklog(c)) console.log(h.falta ? `${h.dia} ${h.hora}: no hay post (${h.motivo})` : `${h.dia} ${h.hora}: sin post, uso ${h.id} del backlog`);
  // Todos los posts de los lotes aprobados, en orden de fecha (antes se recorrían lote por lote y en orden de número:
  // un post del jueves podía ocupar el último lugar de la cola y dejar afuera uno de hoy).
  const items = [];
  for (const dir of lotes(c)) {
    const lote = leer(join(dir, "lote.json"));
    const rutaAprob = join(dir, "aprobacion.json");
    if (!existsSync(rutaAprob)) { console.log(`${lote.lote}: sin aprobar, no se publica`); continue; }
    if (leer(rutaAprob).huella !== huellaLote(dir)) { console.log(`${lote.lote}: cambió después de aprobarlo: no se publica hasta volver a aprobarlo`); continue; }
    const estado = estadoDe(dir);
    const guardarEstado = () => guardar(join(dir, "estado.json"), estado);
    for (const p of publicables(lote)) if (p.fecha) items.push({ dir, lote, estado, guardarEstado, p, base: instante(p.fecha, p.hora, p.zona) });
  }
  items.sort((x, y) => x.base - y.base);

  // Cola de Buffer (plan gratis: 10 por canal): tiene que tener los posts MÁS PRÓXIMOS. Si uno cercano no entra, se
  // saca de Buffer el más lejano de los programados (vuelve a pendiente y se programa cuando haya lugar).
  const COLA = pub.cola_max ?? 10;
  const cuandoEn = (it, red) => new Date(it.base.getTime() + red.desfase_min * 60e3);
  for (const red of activas) {
    const k = red.clave;
    const futuros = items.filter((it) => {
      const t = cuandoEn(it, red).getTime();
      if (t < Date.now() + MARGEN_MS || (red.desde && t < Date.parse(red.desde))) return false;
      if (!redesLote(it.lote).includes(k)) return false; // lote de la otra red (2026-11-23)
      const est = it.estado.piezas[it.p.n]?.[k]?.estado;
      return !est || est === "EN ESPERA" || est === "PROGRAMADO";
    });
    const deseados = new Set(futuros.slice(0, COLA));
    const faltanLugar = futuros.filter((it) => deseados.has(it) && it.estado.piezas[it.p.n]?.[k]?.estado !== "PROGRAMADO").length;
    const sobran = futuros.filter((it) => !deseados.has(it) && it.estado.piezas[it.p.n]?.[k]?.estado === "PROGRAMADO").reverse(); // del más lejano al más cercano
    for (const it of sobran.slice(0, faltanLugar)) {
      const e = it.estado.piezas[it.p.n][k];
      const id = idPieza(it.lote.lote, it.p.n);
      if (simular) { console.log(`SIMULACIÓN ${id} [${red.nombre}]: lo saco de la cola de Buffer para hacer lugar a uno más próximo`); continue; }
      const r = (await buffer("mutation($i: DeletePostInput!) { deletePost(input: $i) { __typename ... on VoidMutationError { message } } }", { i: { id: e.buffer_id } })).deletePost;
      if (r.__typename !== "DeletePostSuccess") { console.log(`${id} [${red.nombre}]: no pude sacarlo de la cola (${r.message ?? r.__typename})`); continue; }
      delete it.estado.piezas[it.p.n][k];
      it.guardarEstado();
      console.log(`${id} [${red.nombre}]: lo saqué de la cola de Buffer (sale el ${it.p.fecha} ${it.p.hora}) para hacer lugar a uno más próximo; se vuelve a programar cuando haya lugar`);
    }
  }

  const llenas = new Set();
  for (const { lote, estado, guardarEstado, p, base } of items) {
    {
      const id = idPieza(lote.lote, p.n);
      const e = (estado.piezas[p.n] ??= {});
      const dir = items.find((it) => it.p === p).dir;
      // CANCELADO: sacado de Buffer a pedido, no se vuelve a programar. Cada lote sale solo en sus redes.
      const faltan = activas.filter((red) => !llenas.has(red.clave) && redesLote(lote).includes(red.clave) && !["PROGRAMADO", "PUBLICADO", "CANCELADO"].includes(e[red.clave]?.estado));
      if (!faltan.length) continue;
      const imagen = join(dir, p.imagen);
      const problemas = [...controlar(p, c, { lote: lote.lote })];
      if (prohibidaPorNombre(p.archivo_original ?? "")) problemas.push(`el archivo original está marcado como no apto (${p.archivo_original})`);
      if (p.imagen !== `${pNN(p.n)}/imagen.jpg`) problemas.push(`la imagen apunta a otra carpeta (${p.imagen})`);
      if (!existsSync(imagen)) problemas.push("no está la imagen");
      else if (sha256(imagen) !== p.sha256) problemas.push("la imagen no es la aprobada (SHA-256 distinto)");
      const texto = textoX(p.texto, c, p.personaje);
      for (const red of faltan) {
        const k = red.clave;
        if (problemas.length) { console.log(`${id} [${red.nombre}] NO SE SUBE: ${problemas.join("; ")}`); e[k] = { estado: "BLOQUEADO", motivo: problemas.join("; ") }; guardarEstado(); continue; }
        const cuando = new Date(base.getTime() + red.desfase_min * 60e3);
        // Bluesky arrancó después que X: lo que salía antes de activarlo no se replica (no es un error).
        if (red.desde && cuando.getTime() < Date.parse(red.desde)) continue;
        if (cuando.getTime() < Date.now() + MARGEN_MS) { console.log(`${id} [${red.nombre}]: la hora (${p.fecha} ${p.hora}) ya pasó; no se publica tarde`); e[k] = { estado: "VENCIDO" }; guardarEstado(); continue; }
        if (simular) { console.log(`SIMULACIÓN ${id} [${red.nombre}] · ${cuando.toISOString()} · ${texto.replace(/\n/g, " ⏎ ")}`); continue; }
        let url;
        try {
          const img = k === "bsky" ? imagenBsky(imagen) : imagen;
          url = await subir(img, `${pub.carpeta_supabase}/${id}-${sha256(img).slice(0, 12)}.jpg`);
        } catch (err) { e[k] = { estado: "FALLIDO", error: err.message }; guardarEstado(); console.log(`${id} [${red.nombre}] FALLIDO · ${err.message}`); continue; }
        const r = (await buffer(
          `mutation($i: CreatePostInput!) { createPost(input: $i) { __typename ... on PostActionSuccess { post { id dueAt status } } ... on MutationError { message } } }`,
          { i: {
            channelId: red.ch.id, text: k === "bsky" ? textoBsky(p.texto, c, p.personaje) : texto, schedulingType: "automatic", mode: "customScheduled", dueAt: cuando.toISOString(),
            // Las imágenes están hechas con IA: en X se marca el post como "hecho con IA"; Bluesky no
            // tiene esa etiqueta, así que se aclara en el texto alternativo.
            assets: [{ image: { url, metadata: { altText: k === "bsky" && pub.imagenes_ia !== false && !/^AI-generated/i.test(p.alt ?? "") ? `AI-generated illustration. ${p.alt ?? ""}`.trim() : p.alt } } }], source: "x-bs-auto",
            ...(k === "x" && pub.imagenes_ia !== false ? { metadata: { twitter: { isAiGenerated: true } } } : {}),
          } },
        )).createPost;
        // Plan gratis de Buffer: hasta 10 publicaciones en cola por canal. Si está llena, queda EN ESPERA
        // y se reintenta en la próxima corrida (cada día se libera un lugar). La otra red sigue.
        const lleno = r.__typename !== "PostActionSuccess" && /limit|queue|maximum/i.test(`${r.__typename} ${r.message ?? ""}`);
        e[k] = r.__typename === "PostActionSuccess"
          ? { estado: "PROGRAMADO", buffer_id: r.post.id, dueAt: r.post.dueAt, canal: red.ch.name }
          : lleno
            ? { estado: "EN ESPERA", motivo: "Cola de Buffer llena (10 por canal): se reintenta en la próxima corrida." }
            : { estado: "FALLIDO", error: `${r.__typename}: ${r.message ?? ""}` };
        guardarEstado();
        console.log(`${id} [${red.nombre}] ${e[k].estado} · ${p.fecha} ${p.hora} ${p.zona}${red.desfase_min ? ` (+${red.desfase_min} min)` : ""}${e[k].error ? " · " + e[k].error : ""}`);
        if (lleno) llenas.add(k);
      }
    }
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });

// Unificar la agenda de X y Bluesky: junta los posts por salir de TODOS los lotes aprobados en una
// sola fila, una por franja de la agenda actual (sin huecos ni horas viejas), sin dos posts seguidos del mismo personaje.
// Sirve cuando cambia la agenda o quedan dos lotes cruzados: los posts viejos quedaban en otras horas (13:00, 21:00) y el
// panel marcaba franjas vacías que en realidad estaban cubiertas.
//   - Respeta el orden actual: cada franja toma el post más próximo cuyo personaje no repita el anterior.
//   - Lo que no cambia de hora queda como está en Buffer. Lo que cambia y ya estaba en Buffer se saca de la cola y
//     publicar.mjs lo vuelve a programar con la hora nueva.
//   - No cambia textos ni imágenes: actualiza la huella de aprobación de los lotes ya aprobados (solo cambian fecha y hora,
//     a pedido de la persona a cargo) y lo deja anotado en aprobacion.json ("reprogramado").
//   node herramientas/reprogramar.mjs --simular   muestra la agenda nueva sin tocar nada
//   node herramientas/reprogramar.mjs             la aplica (después correr publicar.mjs)
import { join } from "node:path";
import { aprobado, cfg, estadoDe, franjasDe, guardar, huellaLote, idPieza, instante, leer, lotes, personajeDe, publicables, sumarDias, hoyEn } from "./comun.mjs";

const c = cfg();
const { zona } = c.publicacion;
const simular = process.argv.includes("--simular");
const MARGEN = 20 * 60e3;
const REDES = ["x", "bsky"];
const NO_SALE = ["PUBLICADO", "VENCIDO", "FALLIDO", "BLOQUEADO", "CANCELADO"];

async function buffer(query, variables = {}) {
  const claves = leer(c.publicacion.publicador);
  const r = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: { Authorization: `Bearer ${claves.buffer_api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`Buffer ${r.status}: ${JSON.stringify(j.errors ?? j).slice(0, 400)}`);
  return j.data;
}

const t = (p) => instante(p.fecha, p.hora, p.zona ?? zona).getTime();
const dirs = lotes(c).filter((d) => leer(join(d, "lote.json")).tipo !== "backlog" && aprobado(d));
const datos = dirs.map((dir) => ({ dir, lote: leer(join(dir, "lote.json")), estado: estadoDe(dir) }));

// Por salir: con fecha, que todavía llegan y que no salieron ni fallaron.
const pend = datos.flatMap((d) => publicables(d.lote).filter((p) => p.fecha && t(p) > Date.now() + MARGEN && !NO_SALE.includes(d.estado.piezas[p.n]?.x?.estado)).map((p) => ({ d, p, antes: `${p.fecha} ${p.hora}` })))
  .sort((a, b) => t(a.p) - t(b.p));
if (!pend.length) { console.log("No hay posts por salir."); process.exit(0); }

// Personaje del último post que ya salió (o que ya no se mueve), para no repetirlo en la primera franja.
const fijos = datos.flatMap((d) => publicables(d.lote).filter((p) => p.fecha && !pend.some((x) => x.p === p)));
let previo = fijos.sort((a, b) => t(a) - t(b)).filter((p) => t(p) <= Date.now() + MARGEN).at(-1);
previo = previo ? personajeDe(previo) : null;

// Franjas de la agenda desde ahora (+20 min), una por post.
const franjas = [];
for (let dia = hoyEn(zona), k = 0; franjas.length < pend.length && k < 400; dia = sumarDias(dia, 1), k++)
  for (const hora of franjasDe(dia, c)) if (franjas.length < pend.length && instante(dia, hora, zona).getTime() > Date.now() + MARGEN) franjas.push({ fecha: dia, hora });

const cola = [...pend];
const plan = [];
for (const f of franjas) {
  const elegido = cola.find((x) => !personajeDe(x.p) || personajeDe(x.p) !== previo) ?? cola[0];
  cola.splice(cola.indexOf(elegido), 1);
  plan.push({ ...elegido, fecha: f.fecha, hora: f.hora });
  previo = personajeDe(elegido.p);
}

let cambian = 0;
for (const x of plan) {
  const nuevo = `${x.fecha} ${x.hora}`;
  const cambia = nuevo !== x.antes || (x.p.zona ?? zona) !== zona;
  if (cambia) cambian++;
  console.log(`${nuevo}  ${(x.p.personaje ?? "").padEnd(10)} ${idPieza(x.d.lote.lote, x.p.n)}${cambia ? `  (antes ${x.antes})` : ""}`);
}
console.log(`\n${plan.length} post(s) por salir; ${cambian} cambian de hora.`);
if (simular || !cambian) process.exit(0);

// Aplicar: primero sacar de Buffer lo que cambia de hora, después guardar fechas y actualizar la aprobación.
for (const x of plan) {
  if (`${x.fecha} ${x.hora}` === x.antes && (x.p.zona ?? zona) === zona) continue;
  const e = x.d.estado.piezas[x.p.n] ?? {};
  for (const k of REDES) {
    if (e[k]?.estado === "PROGRAMADO" && e[k].buffer_id) {
      const r = (await buffer("mutation($i: DeletePostInput!) { deletePost(input: $i) { __typename ... on VoidMutationError { message } } }", { i: { id: e[k].buffer_id } })).deletePost;
      if (r.__typename !== "DeletePostSuccess") throw new Error(`${idPieza(x.d.lote.lote, x.p.n)} [${k}]: no pude sacarlo de Buffer (${r.message ?? r.__typename}). No se cambió nada más.`);
    }
    if (e[k] && e[k].estado !== "PUBLICADO") delete e[k];
  }
  Object.assign(x.p, { fecha: x.fecha, hora: x.hora, zona });
  guardar(join(x.d.dir, "estado.json"), x.d.estado); // se guarda en cada paso: si algo falla, lo ya sacado de Buffer queda registrado
}
for (const d of datos) {
  guardar(join(d.dir, "lote.json"), d.lote);
  const rutaA = join(d.dir, "aprobacion.json");
  const a = leer(rutaA);
  guardar(rutaA, { ...a, huella: huellaLote(d.dir), reprogramado: [...(a.reprogramado ?? []), new Date().toISOString()] });
}
console.log("Listo. Ahora: node herramientas/publicar.mjs (vuelve a programar en Buffer lo que se movió).");

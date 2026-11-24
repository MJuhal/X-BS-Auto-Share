// Asistente de interacción de Pixiv: busca obras recientes afines (personajes de Patreon +
// AIイラスト) y propone un comentario para cada una. NO interactúa: la persona a cargo abre la obra y decide si comenta, sigue o
// salta (el asistente no comenta, no da like, no sigue ni manda mensajes). Los concursos oficiales
// los revisa pixiv-concursos.mjs.
// Navegación liviana, como una persona: una página por etiqueta, con pausas, una vez al día cuando la persona a cargo lo pide.
//   node herramientas/pixiv-sugerencias.mjs               arma las sugerencias del día en config/interaccion/<fecha>.json
//   node herramientas/pixiv-sugerencias.mjs --reescribir  reescribe los comentarios de las pendientes (sin buscar nada)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { nombraMarca, cfg, guardar, hoyEn, leer, prohibido, RAIZ } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";
import { confPixiv, ETIQUETAS, personajesPatreon } from "./pixiv-comun.mjs";
import { abrir, cuentaDe } from "./pixiv.mjs";

export const DIR_INTERACCION = join(RAIZ, "config/interaccion");
const CANTIDAD = 12; // sugerencias por búsqueda
const POR_PERSONAJE = 2;
const DIAS_SIN_REPETIR_ARTISTA = 14;
const ANTIGUEDAD_MAX_MS = 30 * 86400e3; // (confirmado 2026-11-20): nada de más de un mes
// Fecha de publicación de una obra, sacada de la dirección de su imagen (".../img/2026/11/09/22/19/21/...").
const fechaObra = (src) => { const m = (src ?? "").match(/\/img\/(\d{4})\/(\d{2})\/(\d{2})\//); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const reciente = (f) => !!f && Date.now() - Date.parse(`${f}T12:00:00Z`) <= ANTIGUEDAD_MAX_MS;

const c = cfg();
const cp = confPixiv(c);
const hoy = hoyEn("America/Argentina/Buenos_Aires");
const dirHoy = join(DIR_INTERACCION, hoy);
mkdirSync(dirHoy, { recursive: true });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (a, b) => a + Math.random() * (b - a);

// Historial: una obra ya sugerida no vuelve nunca; un artista no se repite en 14 días; los comentarios no se repiten.
const archivos = readdirSync(DIR_INTERACCION).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const historial = archivos.map((f) => leer(join(DIR_INTERACCION, f)));
const idsVistos = new Set(historial.flatMap((d) => d.obras.map((o) => o.id)));
const limiteArtista = new Date(Date.now() - DIAS_SIN_REPETIR_ARTISTA * 86400e3).toISOString().slice(0, 10);
const artistasVistos = new Set(historial.filter((d) => d.fecha >= limiteArtista).flatMap((d) => d.obras.map((o) => o.uid)));
const ruta = join(DIR_INTERACCION, `${hoy}.json`);
// Lo que sigue a la vista: del mismo día, todo; de un día anterior, solo lo pendiente que tenga menos de un mes.
const anterior = historial.at(-1) ?? null;
const conservadas = (anterior?.obras ?? []).filter((o) => anterior.fecha === hoy || (o.estado === "pendiente" && reciente(o.fecha_obra)));
const comentariosPrevios = historial.flatMap((d) => d.obras.map((o) => o.comentario_en ?? o.comentario_ja).filter(Boolean)).slice(-60);

// --reescribir: vuelve a escribir los comentarios de las sugerencias pendientes (p. ej. si cambió el tono).
if (process.argv.includes("--reescribir")) {
  if (!anterior) { console.log("No hay sugerencias para reescribir."); process.exit(0); }
  const rutaAnt = join(DIR_INTERACCION, `${anterior.fecha}.json`);
  const d = leer(rutaAnt);
  const pend = d.obras.filter((o) => o.estado === "pendiente" && !o.saltar);
  const fijos = new Set(pend.map((o) => o.comentario_en ?? o.comentario_ja));
  for (const o of pend) { delete o.comentario_ja; o.comentario_en = null; o.por_que = null; }
  guardar(rutaAnt, d);
  guardar(join(dirHoy, "comentarios-previos.json"), comentariosPrevios.filter((t) => !fijos.has(t)));
  console.log(`== Reescribo ${pend.length} comentarios`);
  await redactar(rutaAnt);
  process.exit(0);
}

// Búsquedas: League of Legends primero y, para sumar gente que conoce o juega LoL, fanart de
// Overwatch, Valorant, Arcane y World of Warcraft. En cada una, primero lo hecho con IA y después todo (también obras
// de artistas que dibujan a mano). El personaje de LoL sale de las etiquetas (primero los de Patreon).
const pat = personajesPatreon(c);
const AFINES = ETIQUETAS.afines ?? {};
const BUSQUEDAS = [
  ...[`League_of_Legends ${ETIQUETAS.ia}`, `英雄联盟 ${ETIQUETAS.ia}`, `LOL ${ETIQUETAS.ia}`].map((tag) => ({ tag, origen: "ia", paginas: 3, grupo: "lol" })),
  ...[...pat].filter((p) => ETIQUETAS.personajes[p]).sort(() => Math.random() - 0.5).map((p) => ({ tag: ETIQUETAS.personajes[p][0], origen: "general", paginas: 1, grupo: "lol", pj: p })),
  ...ETIQUETAS.franquicia.map((tag) => ({ tag, origen: "general", paginas: 2, grupo: "lol" })),
  ...Object.entries(AFINES).flatMap(([grupo, a]) => [
    { tag: `${a.tags[0]} ${ETIQUETAS.ia}`, origen: "ia", paginas: 1, grupo },
    ...a.tags.slice(0, 2).map((tag) => ({ tag, origen: "general", paginas: 1, grupo })),
  ]),
];
const LOL_MAX = 6; // de LoL primero hasta 6; de cada afín hasta 2; si sobra lugar, se completa con LoL
const POR_AFIN = 2;
const nombres = Object.entries(ETIQUETAS.personajes).map(([pj, ts]) => [pj, ts.map((t) => t.toLowerCase().replace(/\(lol\)$/, ""))]);
const personajeDe = (tags) => {
  const bajos = tags.map((t) => t.toLowerCase().replace(/\(lol\)$/, ""));
  const hallados = nombres.filter(([, ts]) => ts.some((t) => bajos.includes(t))).map(([pj]) => pj);
  return hallados.find((p) => pat.has(p)) ?? hallados[0] ?? "otro";
};
const nav = await abrir({ visible: false });
const candidatas = [];
const obras = [];
try {
  if ((await cuentaDe(nav)) !== cp.usuario_id) throw new Error('No hay sesión de la cuenta de marca en Pixiv: tocá "Iniciar sesión en Pixiv".');
  const pg = (await nav.pages())[0];
  await pg.setViewport({ width: 1280, height: 1600 });
  // cuántas candidatas de LoL se pueden usar de verdad (como mucho 2 por personaje)
  const lol = () => candidatas.filter((x) => x.grupo === "lol");
  const utilesLol = () => [...new Set(lol().map((x) => x.personaje))].reduce((a, pj) => a + Math.min(POR_PERSONAJE, lol().filter((x) => x.personaje === pj).length), 0);
  const deGrupo = (g) => candidatas.filter((x) => x.grupo === g).length;
  const basta = (g) => (g === "lol" ? utilesLol() >= CANTIDAD : deGrupo(g) >= POR_AFIN + 1);
  for (const { tag, origen, paginas, grupo, pj: pjBuscado } of BUSQUEDAS) {
    if (basta(grupo)) continue;
    for (let pagina = 1; pagina <= paginas; pagina++) {
      console.log(`Busco: ${tag} (página ${pagina})`);
      await pg.goto(`https://www.pixiv.net/en/tags/${encodeURIComponent(tag)}/illustrations${pagina > 1 ? `?p=${pagina}` : ""}`, { waitUntil: "networkidle2", timeout: 60000 });
      await espera(azar(2500, 4500));
      const encontradas = await pg.evaluate(() => {
        const m = new Map();
        for (const a of document.querySelectorAll('a[href*="/artworks/"]')) {
          const img = a.querySelector("img");
          if (!img) continue;
          const id = a.getAttribute("href").match(/artworks\/(\d+)/)?.[1];
          if (!id || m.has(id)) continue;
          let k = a.parentElement;
          while (k && !k.querySelector('a[href*="/users/"]')) k = k.parentElement;
          const u = k?.querySelector('a[href*="/users/"]');
          const titulo = [...(k?.querySelectorAll(`a[href*="/artworks/${id}"]`) ?? [])].filter((x) => !x.querySelector("img")).map((x) => x.innerText.trim()).find(Boolean) ?? ""; // la miniatura muestra la cantidad de páginas
          const autor = [...(k?.querySelectorAll('a[href*="/users/"]') ?? [])].map((x) => x.innerText.trim()).find(Boolean) ?? "";
          const [tags, tit2] = (img.alt ?? "").split(" / ");
          const src = img.src;
          m.set(id, { id, titulo: titulo || tit2 || "", autor, uid: u?.getAttribute("href").match(/users\/(\d+)/)?.[1] ?? null, etiquetas: (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean), src });
        }
        return [...m.values()];
      });
      // Miniaturas de las que sirven (captura de la tarjeta, sin descargar nada aparte).
      let recientes = 0;
      for (const o of encontradas) {
        o.fecha_obra = fechaObra(o.src);
        delete o.src;
        if (!reciente(o.fecha_obra)) continue;
        recientes++;
        if (idsVistos.has(o.id) || basta(grupo)) continue;
        if (o.etiquetas.some(prohibido)) continue; // yordles y personajes que pueden parecer menores (comun.mjs)
        if (!o.uid || o.uid === cp.usuario_id || artistasVistos.has(o.uid) || candidatas.some((x) => x.uid === o.uid || x.id === o.id)) continue;
        const pj = grupo !== "lol" ? grupo : personajeDe(o.etiquetas) === "otro" && pjBuscado ? pjBuscado : personajeDe(o.etiquetas);
        if (grupo === "lol" && candidatas.filter((x) => x.personaje === pj).length >= POR_PERSONAJE + 1) continue;
        const el = await pg.$(`a[href*="/artworks/${o.id}"] img`);
        if (!el) continue;
        await el.scrollIntoView();
        await espera(azar(300, 700));
        const mini = join(dirHoy, `${o.id}.png`);
        await el.screenshot({ path: mini }).catch(() => null);
        if (!existsSync(mini)) continue;
        candidatas.push({ ...o, personaje: pj, grupo, link: `https://www.pixiv.net/en/artworks/${o.id}`, perfil: `https://www.pixiv.net/en/users/${o.uid}`, mini, origen, estado: "pendiente", comentario_en: null, por_que: null, saltar: false, nota: null });
      }
      await espera(azar(4000, 8000));
      if (!recientes || basta(grupo)) break; // orden por más nuevas: si esta página ya es vieja, las siguientes también
    }
  }
  // Elección: LoL hasta 6 (primero IA, después Patreon; 2 por personaje), cada afín hasta 2 (primero IA) y, si queda
  // lugar, más LoL.
  const orden = (x, y) => (x.origen === "ia" ? 0 : 1) - (y.origen === "ia" ? 0 : 1) || pat.has(y.personaje) - pat.has(x.personaje);
  const tomar = (lista, tope) => { for (const o of lista) { if (obras.length >= CANTIDAD || tope() ) break; if (!obras.includes(o) && obras.filter((x) => x.personaje === o.personaje).length < POR_PERSONAJE) obras.push(o); } };
  const deLol = candidatas.filter((x) => x.grupo === "lol").sort(orden);
  tomar(deLol, () => obras.filter((x) => x.grupo === "lol").length >= LOL_MAX);
  for (const g of Object.keys(AFINES)) tomar(candidatas.filter((x) => x.grupo === g).sort(orden), () => obras.filter((x) => x.grupo === g).length >= POR_AFIN);
  tomar(deLol, () => false);
} finally { await nav.close().catch(() => {}); }

if (!obras.length) { console.log("No encontré obras nuevas para sugerir hoy."); }
const datos = { fecha: hoy, generado: new Date().toISOString(), nuevas: obras.length, obras: [...conservadas, ...obras] };
guardar(ruta, datos);
guardar(join(dirHoy, "comentarios-previos.json"), comentariosPrevios);

// También las que quedaron sin comentario de una corrida anterior que falló (2026-11-23, mismo caso que Bluesky).
const sinComentario = datos.obras.filter((o) => o.estado === "pendiente" && !o.saltar && !o.comentario_en).length;
if (sinComentario) {
  console.log(`== Comentarios sugeridos para ${sinComentario} obras`);
  await redactar(ruta);
}
console.log(`Sugerencias: ${obras.length} obras.`);

/** Escribe (con la IA) los comentarios que faltan en el archivo de sugerencias y controla la autopromoción. */
async function redactar(ruta) {
  const prompt = [
    `Leé ${join(RAIZ, "docs/instrucciones-interaccion.md")} y seguilas al pie de la letra.`,
    `Completá los comentarios sugeridos en ${ruta}, solo en las obras con "comentario_en" en null y "saltar" en false (el comentario va siempre en inglés) (cada obra tiene su miniatura en el campo "mini": abrila y mirala).`,
    `Los comentarios de días anteriores están en ${join(dirHoy, "comentarios-previos.json")}: no los repitas.`,
  ].join(" ");
  const codigo = await ejecutarIA(prompt, { herramientas: "Read,Edit,Write", dirs: [DIR_INTERACCION] });
  const final = leer(ruta);
  // Lo que la IA decide saltar va directo al historial con el motivo (como en Bluesky y X): en la vista quedan
  // solo las obras que se pueden comentar.
  for (const o of final.obras) if (o.saltar && o.estado === "pendiente" && !o.comentario_en) { o.estado = "saltado"; o.nota = `Saltado solo: ${o.nota ?? "mejor no comentar"}`; }
  // Control: sin autopromoción ni links aunque la redacción se equivoque.
  for (const o of final.obras) {
    const t = `${o.comentario_ja ?? ""} ${o.comentario_en ?? ""}`;
    if (nombraMarca(t) || /https?:|www\.|@|patreon|follow|profile|プロフィール|フォロー/i.test(t)) { o.saltar = true; o.nota = `Comentario descartado por autopromoción: ${o.nota ?? ""}`.trim(); delete o.comentario_ja; o.comentario_en = null; }
  }
  guardar(ruta, final);
  console.log(codigo === 0 ? "LISTO" : `La redacción terminó con código ${codigo}`);
}

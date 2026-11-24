// Respuestas sugeridas para X: la persona a cargo pega lo que le dio Grok y la IA propone una respuesta
// por post con la voz de la marca. Leer X automático es pago (API): esto es gratis. NO publica nada: la persona a cargo responde a
// mano desde la cuenta de la marca.
//   - Grok responde en formato fijo, una línea por post: "POST | link | @cuenta | seguidores | imagen | descripción".
//   - Un post que ya se pegó antes (mismo link) se descarta: Grok no recuerda de forma confiable entre chats.
//   - Si Grok pasa el link directo de la imagen (pbs.twimg.com/media), se descarga y la IA la MIRA antes de escribir
//     (Grok a veces se equivoca con colores u hora del día). Sin imagen, la respuesta no menciona detalles visuales finos.
//   node herramientas/x-respuestas.mjs <archivo-con-lo-pegado>   agrega las respuestas a config/x-respuestas.json
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nombraMarca, guardar, leer, RAIZ } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";

mkdirSync(join(RAIZ, "config/trabajo"), { recursive: true }); // carpeta de trabajo de la IA: sin claves
const RUTA = join(RAIZ, "config/x-respuestas.json");
const RUTA_VISTOS = join(RAIZ, "config/x-vistos.json");
const DIR_IMGS = join(RAIZ, "config/x-imgs");
mkdirSync(DIR_IMGS, { recursive: true });
const archivo = process.argv[2];
const idDe = (link) => (link ?? "").match(/status(?:es)?\/(\d+)/)?.[1] ?? null;
// Comprobación de cada link: con el endpoint público de los embeds de X (el mismo que usan las
// webs para mostrar un post; no es la API paga ni pide sesión, y no es oficial: si deja de andar, los posts pasan sin
// verificar). Sirve para descartar posts inventados o viejos cuando la lista viene de ChatGPT o la IA en vez de Grok.
const MAX_EDAD_H = 72;
// Link al post en x.com aunque venga sin https, de twitter.com o de un espejo (Sotwe, Nitter, xcancel, fxtwitter,
// vxtwitter, fixupx): ChatGPT y las búsquedas web suelen citar espejos. Toma el número del post; la cuenta real la
// completa la verificación (si no, queda la del link o "i", que X redirige igual).
function linkX(texto) {
  const t = String(texto ?? "");
  const m = t.match(/(?:x|twitter)\.com\/(\w{1,15})\/status(?:es)?\/(\d{10,20})/i)
    ?? t.match(/(?:nitter\.[\w.]+|xcancel\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)\/(\w{1,15})\/status\/(\d{10,20})/i);
  if (m) return `https://x.com/${m[1]}/status/${m[2]}`;
  const s = t.match(/sotwe\.com\/(?:tweet|status)\/(\d{10,20})/i) ?? t.match(/\/status(?:es)?\/(\d{10,20})/i);
  return s ? `https://x.com/i/status/${s[1]}` : null;
}
async function verificar(id) {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  try {
    const r = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`, { signal: AbortSignal.timeout(10000) });
    if (r.status === 404) return "no_existe";
    if (!r.ok) return null;
    const j = await r.json();
    if (j.__typename === "TweetTombstone" || !j.created_at) return "no_existe"; // borrado o no visible
    return j;
  } catch { return null; } finally { await new Promise((ok) => setTimeout(ok, 400)); }
}

const correrIA = (prompt) => ejecutarIA(prompt, { herramientas: "Read,Edit,Write", dirs: [join(RAIZ, "config/trabajo")] });

try {
  const pegado = readFileSync(archivo, "utf8").slice(0, 15000);
  const todo = existsSync(RUTA) ? leer(RUTA) : { tandas: [] };
  const vistos = existsSync(RUTA_VISTOS) ? leer(RUTA_VISTOS) : { posts: [] };
  const yaVistos = new Set(vistos.posts.map((v) => v.id));
  const previas = todo.tandas.flatMap((t) => t.posts.map((p) => p.respuesta)).filter(Boolean).slice(-60);

  // 1) Lectura del formato fijo de Grok. Si no viene así, la IA separa los posts (sin imágenes).
  // Se corta en cada "POST |", no por línea: a veces Grok devuelve todos los posts pegados en una sola línea.
  let posts = pegado.replace(/\*\*/g, "").split(/(?=\bPOST\s*\|)/i).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => /^POST\s*\|/i.test(l)).map((l) => {
    const [, link, cuenta, seguidores, imagen, ...desc] = l.split("|").map((x) => x.trim());
    return { link: linkX(link) ?? linkX(l), cuenta: cuenta?.startsWith("@") ? cuenta : cuenta ? `@${cuenta}` : null, seguidores: seguidores ?? null, imagen_url: (imagen ?? "").match(/https:\/\/pbs\.twimg\.com\/media\/[^\s)]+/)?.[0] ?? null, descripcion: desc.join(" | ") || null };
  });
  if (!posts.length) {
    const tmpP = join(RAIZ, "config/trabajo/x-respuestas-separar.json");
    guardar(tmpP, { pegado, posts: [] });
    console.log("== El texto no vino en el formato fijo: la IA separa los posts");
    await correrIA(`En ${tmpP}, "pegado" es lo que pegó la persona a cargo (lista de Grok o texto de posts de X). Separá cada post y completá "posts" con {"link": link al post o null, "cuenta": "@usuario" o null, "seguidores": texto o null, "imagen_url": link directo pbs.twimg.com/media si figura, o null, "descripcion": lo que se dice del post, tal cual}. No inventes posts. No toques otros archivos.`);
    posts = (leer(tmpP).posts ?? []).map((p) => ({ ...p, link: linkX(p.link) }));
    rmSync(tmpP, { force: true });
  }

  // 2) Repetidos fuera, cada link comprobado contra X, imágenes descargadas.
  const repetidos = [];
  const nuevos = [];
  const descartados = { inexistentes: 0, viejos: 0, sin_verificar: 0 };
  for (const p of posts) {
    const id = idDe(p.link);
    if (id && (yaVistos.has(id) || nuevos.some((x) => idDe(x.link) === id))) { repetidos.push(p.cuenta ?? p.link); continue; }
    if (id) {
      const real = await verificar(id);
      if (real === "no_existe") { descartados.inexistentes++; console.log(`Descartado (el post no existe): ${p.link}`); continue; }
      if (real && Date.now() - Date.parse(real.created_at) > MAX_EDAD_H * 3600e3) { descartados.viejos++; console.log(`Descartado (tiene más de ${MAX_EDAD_H} h): ${p.link}`); continue; }
      if (real) {
        // Lo que dice X manda sobre lo que dijo la IA (cuenta, imagen, texto): una IA sin acceso a X puede inventarlo.
        const cuenta = real.user?.screen_name;
        if (cuenta) { p.cuenta = `@${cuenta}`; p.link = `https://x.com/${cuenta}/status/${id}`; }
        const foto = (real.photos ?? [])[0]?.url ?? (real.mediaDetails ?? []).find((m) => m.type === "photo")?.media_url_https;
        p.imagen_url = foto && /^https:\/\/pbs\.twimg\.com\/media\//.test(foto) ? foto : null;
        p.texto = String(real.text ?? "").slice(0, 400) || null;
        p.publicado = real.created_at;
        p.respuestas_post = real.conversation_count ?? null;
        p.likes_post = real.favorite_count ?? null;
        if (real.possibly_sensitive) p.sensible = true;
        p.verificado = true;
      } else descartados.sin_verificar++; // X no respondió: queda, sin verificar
    }
    if (p.imagen_url) {
      try {
        const r = await fetch(p.imagen_url);
        if (r.ok && (r.headers.get("content-type") ?? "").startsWith("image/")) {
          const f = join(DIR_IMGS, `${id ?? Date.now().toString(36)}.jpg`);
          writeFileSync(f, Buffer.from(await r.arrayBuffer()));
          p.mini = f;
        }
      } catch {}
    }
    nuevos.push(p);
  }
  console.log(`Posts: ${posts.length}; repetidos descartados: ${repetidos.length}; inexistentes: ${descartados.inexistentes}; viejos: ${descartados.viejos}; sin verificar: ${descartados.sin_verificar}; con imagen: ${nuevos.filter((p) => p.mini).length}`);

  // 3) Respuestas.
  const tmp = join(RAIZ, "config/trabajo/x-respuestas-tanda.json");
  guardar(tmp, { respuestas_previas: previas, posts: nuevos.map((p) => ({ ...p, resumen: null, respuesta: null, saltar: false, nota: null })) });
  if (nuevos.length) {
    console.log("== Respuestas para X");
    await correrIA([
      `Leé ${join(RAIZ, "docs/instrucciones-interaccion.md")} y seguilas: valen igual para X (respuestas cortas de fan, en inglés, voz silly y cute, sin coqueteo ni autopromoción; en X nada de pedir likes ni follows).`,
      `Los posts pueden ser de tres tipos (va al principio de "descripcion"): "fan art" (respondé al arte, como siempre), "curator" (cuenta que comparte arte de otros: respondé a la obra compartida, sin felicitar a la cuenta como si fuera la autora) o "fan talk" (fans charlando de League of Legends: una skin, su main, un evento, Arcane). En "fan talk" respondé como otro jugador sobre ESE tema (tu opinión de la skin, tu main, una broma de ranked), corto y con onda; nunca hables de arte, de crear imágenes ni de tu cuenta. Saltá los hilos de pelea o tóxicos.`,
      `En ${tmp}, completá en cada post: "resumen" (en español, una línea con qué muestra), "respuesta" (en inglés, distinta de "respuestas_previas" y de las otras de esta tanda), "saltar" (true si conviene no responder: explícito, posible menor, política, polémica; en ese caso "respuesta": null) y "nota" (el motivo o null).`,
      `MUY IMPORTANTE con los detalles visuales: si el post tiene "mini", abrí esa imagen y basá la respuesta en lo que ves vos; la "descripcion" la escribió otra IA (Grok u otra) y puede equivocarse (colores, día o noche). Si hay "texto", es lo que dice el post de verdad (sacado de X): usalo para entender el contexto. Si "sensible" es true, X lo marca como contenido sensible: poné "saltar": true salvo que la imagen muestre claramente que no es explícito. Si NO tiene "mini", no menciones colores, luz, hora del día ni detalles visuales finos: usá pura emoción o un detalle seguro (personaje, ropa) que esté en la descripción y no esté marcado "unclear".`,
      `No toques otros archivos.`,
    ].join(" "));
  }
  const r = leer(tmp);
  rmSync(tmp, { force: true });
  const final = (r.posts ?? []).map((p, i) => {
    const base = { ...p, link: /^https:\/\/(x|twitter)\.com\//.test(p.link ?? "") ? p.link : null, id: `${Date.now().toString(36)}-${i}`, estado: "pendiente" };
    if (p.respuesta && (nombraMarca(p.respuesta) || /https?:|www\.|patreon|follow me|my profile|check my|like if|rt if/i.test(p.respuesta))) return { ...base, saltar: true, respuesta: null, nota: "Respuesta descartada por autopromoción." };
    // Lo que la IA decide saltar va directo al historial con el motivo (como en Bluesky y Pixiv).
    if (p.saltar) return { ...base, estado: "saltado", nota: `Saltado solo: ${p.nota ?? "mejor no responder"}` };
    return base;
  });
  todo.tandas.unshift({ creado: new Date().toISOString(), posts: final, repetidos: repetidos.length, descartados });
  todo.tandas = todo.tandas.slice(0, 15);
  guardar(RUTA, todo);
  // Registro de vistos (60 días): links y cuentas, para descartar repetidos y armar la exclusión del pedido a Grok.
  const ahora = new Date().toISOString();
  for (const p of final) { const id = idDe(p.link); if (id) vistos.posts.push({ id, link: p.link, cuenta: p.cuenta ?? null, fecha: ahora }); }
  vistos.posts = vistos.posts.filter((v) => Date.now() - Date.parse(v.fecha) < 60 * 86400e3);
  guardar(RUTA_VISTOS, vistos);
  console.log(`LISTO: ${final.length} post(s), ${repetidos.length} repetido(s) descartado(s).`);
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { if (archivo && /entrada-\d+\.txt$/.test(archivo)) rmSync(archivo, { force: true }); }

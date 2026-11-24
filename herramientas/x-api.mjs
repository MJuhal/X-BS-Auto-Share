// Acceso de solo lectura a la API de X para los sorteos. Es paga por uso: cada corrida se confirma
// en el panel con el costo estimado antes de gastar (regla 4). Nada de esto publica, da like, sigue ni manda mensajes.
// Credenciales: x_client_id y x_client_secret en el archivo de claves (config.publicacion.publicador, fuera del repo).
// La sesión de la cuenta de la marca (OAuth 2.0 con PKCE) queda en config/x-api-sesion.json (config/ está fuera de git).
//   node herramientas/x-api.mjs --conectar    abre el navegador para que la persona a cargo autorice la app (una sola vez)
//   node herramientas/x-api.mjs --estado      dice si hay sesión y de qué cuenta
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cfg, guardar, leer, RAIZ } from "./comun.mjs";

const RUTA_SESION = join(RAIZ, "config/x-api-sesion.json");
const PUERTO = 8766;
export const REDIRECCION = `http://127.0.0.1:${PUERTO}/callback`;
const ALCANCES = "tweet.read users.read follows.read like.read offline.access";
const API = "https://api.x.com/2";

function credenciales() {
  const c = leer(cfg().publicacion.publicador);
  if (!c.x_client_id) throw new Error("Falta conectar la API de X: agregá x_client_id y x_client_secret al archivo de claves (ver docs/sorteos.md).");
  return { id: c.x_client_id, secreto: c.x_client_secret ?? null };
}
export const hayCredenciales = () => { try { credenciales(); return true; } catch { return false; } };
export const sesion = () => (existsSync(RUTA_SESION) ? leer(RUTA_SESION) : null);

async function token(params) {
  const { id, secreto } = credenciales();
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const cuerpo = new URLSearchParams(params);
  if (secreto) headers.Authorization = `Basic ${Buffer.from(`${id}:${secreto}`).toString("base64")}`;
  else cuerpo.set("client_id", id);
  const r = await fetch(`${API}/oauth2/token`, { method: "POST", headers, body: cuerpo });
  const j = await r.json();
  if (!r.ok) throw new Error(`X rechazó el token: ${j.error_description ?? j.error ?? r.status}`);
  return { access: j.access_token, refresh: j.refresh_token ?? null, vence: Date.now() + (j.expires_in ?? 7200) * 1000 - 60e3 };
}

async function accesoVigente() {
  const s = sesion();
  if (!s) throw new Error('No hay sesión de X: tocá "Conectar X" en el panel.');
  if (Date.now() < s.vence) return s.access;
  if (!s.refresh) throw new Error('La sesión de X venció: tocá "Conectar X" de nuevo.');
  const t = await token({ grant_type: "refresh_token", refresh_token: s.refresh });
  guardar(RUTA_SESION, { ...s, ...t, refresh: t.refresh ?? s.refresh });
  return t.access;
}

/** GET a la API v2 (solo lectura). Lleva la cuenta de lo leído para comparar con lo estimado. */
export const lecturas = { posts: 0, usuarios: 0, seguidores: 0 };
export async function get(ruta, params = {}) {
  const u = new URL(`${API}${ruta}`);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  for (let intento = 0; intento < 3; intento++) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${await accesoVigente()}` } });
    if (r.status === 429) { const espera = Math.max(5e3, (Number(r.headers.get("x-rate-limit-reset") ?? 0) * 1000) - Date.now()); console.log(`X pide esperar ${Math.round(espera / 1000)} s (límite de pedidos).`); await new Promise((ok) => setTimeout(ok, Math.min(espera, 15 * 60e3))); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(`X respondió ${r.status} en ${ruta}: ${j.detail ?? j.title ?? JSON.stringify(j).slice(0, 200)}`);
    return j;
  }
  throw new Error(`X sigue limitando los pedidos en ${ruta}. Probá más tarde.`);
}

/** Recorre todas las páginas de un endpoint con paginación de X. */
export async function todas(ruta, params, clave = "data") {
  const out = [];
  let next = null;
  for (let i = 0; i < 200; i++) {
    const j = await get(ruta, { ...params, pagination_token: next ?? undefined });
    out.push(...(j[clave] ?? []));
    if (j.includes?.users) out.incluidos = [...(out.incluidos ?? []), ...j.includes.users];
    next = j.meta?.next_token;
    if (!next) break;
  }
  return out;
}

async function conectar() {
  const { id } = credenciales();
  const verificador = randomBytes(48).toString("base64url");
  const desafio = createHash("sha256").update(verificador).digest("base64url");
  const estado = randomBytes(16).toString("hex");
  const url = new URL("https://x.com/i/oauth2/authorize");
  Object.entries({ response_type: "code", client_id: id, redirect_uri: REDIRECCION, scope: ALCANCES, state: estado, code_challenge: desafio, code_challenge_method: "S256" }).forEach(([k, v]) => url.searchParams.set(k, v));
  await new Promise((ok, mal) => {
    const corte = setTimeout(() => { srv.close(); mal(new Error("Pasaron 5 minutos sin autorizar. Probá de nuevo.")); }, 5 * 60e3);
    const srv = createServer(async (req, res) => {
      const q = new URL(req.url, REDIRECCION);
      if (q.pathname !== "/callback") { res.writeHead(404); return res.end(); }
      const fin = (txt, error) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<p style="font:16px system-ui;padding:24px">${txt}</p>`); clearTimeout(corte); srv.close(); error ? mal(error) : ok(); };
      if (q.searchParams.get("state") !== estado) return fin("Pedido inválido.", new Error("El estado de la autorización no coincide."));
      if (q.searchParams.get("error")) return fin("No se autorizó la app.", new Error("la persona a cargo no autorizó la app en X."));
      try {
        const t = await token({ grant_type: "authorization_code", code: q.searchParams.get("code"), redirect_uri: REDIRECCION, code_verifier: verificador });
        guardar(RUTA_SESION, { ...t, conectado: new Date().toISOString() });
        const yo = (await get("/users/me")).data;
        guardar(RUTA_SESION, { ...leer(RUTA_SESION), cuenta: yo.username, id: yo.id });
        console.log(`Conectado como @${yo.username}.`);
        fin(`Listo: X conectado como @${yo.username}. Podés cerrar esta pestaña.`);
      } catch (e) { fin("Algo falló al conectar. Mirá el panel.", e); }
    }).listen(PUERTO, "127.0.0.1", () => {
      console.log("Abrí el navegador: autorizá la app con la cuenta la cuenta de la marca.");
      spawn("cmd", ["/c", "start", "", url.toString()], { detached: true, stdio: "ignore" }).unref();
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--conectar")) await conectar();
    else { const s = sesion(); console.log(s ? `Sesión de X: @${s.cuenta ?? "?"} (conectada ${s.conectado})` : "Sin sesión de X."); }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

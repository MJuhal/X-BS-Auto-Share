// Pruebas locales, sin red ni cuentas: configuración aislada en una carpeta temporal.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const T = mkdtempSync(join(tmpdir(), "xbs-"));
process.env.X_CONFIG = join(T, "x.json");
process.env.X_CLAVES = join(T, "claves.json");
const PUERTO = 4490 + Math.floor(Math.random() * 300);
const { accionesAsistente: A } = await import("../herramientas/panel/asistente.mjs");
const { argumentosCodex, imagenesDelPedido } = await import("../herramientas/ia.mjs");
const { cfg, configurado, nombraMarca, redes } = await import("../herramientas/comun.mjs");
const real = globalThis.fetch;
let panel;
after(() => { panel?.kill(); rmSync(T, { recursive: true, force: true }); });
const guardada = () => JSON.parse(readFileSync(process.env.X_CONFIG, "utf8"));
const claves = () => JSON.parse(readFileSync(process.env.X_CLAVES, "utf8"));
const resp = (d, ok = true, status = 200) => ({ ok, status, json: async () => d });

test("arranca sin configuración", async () => {
  assert.equal(configurado(), false);
  assert.deepEqual(redes(), []);
  assert.equal((await A.asis_estado()).faltan.length, 6);
  await assert.rejects(A.asis_terminar(), /Todavía falta/);
});
test("Codex: permisos mínimos, imágenes adjuntas y pedido por stdin", () => {
  const a = argumentosCodex({ dirs: ["C:/trabajo"], imgs: ["a.jpg", "b.jpg"], web: false });
  assert.deepEqual(a, ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "workspace-write", "-C", "C:/trabajo", "-i", "a.jpg", "-i", "b.jpg", "-"]);
});
test("junta solo las imágenes pendientes del pedido", () => {
  mkdirSync(join(T, "p01"));
  for (const f of ["p01/imagen.jpg", "x.png"]) writeFileSync(join(T, f), "x");
  const j = join(T, "lote.json");
  writeFileSync(j, JSON.stringify({ piezas: [{ imagen: "p01/imagen.jpg", original: "no-existe.png" }, { mini: join(T, "x.png"), saltar: true }] }));
  assert.deepEqual(imagenesDelPedido(`Escribí en ${j} (leelo primero).`), [join(T, "p01/imagen.jpg")]);
});
test("carpetas: crea todo y rechaza la del proyecto", async () => {
  await assert.rejects(A.asis_carpetas({ carpeta: join(import.meta.dirname, "..", "x") }), /fuera del proyecto/);
  await assert.rejects(A.asis_carpetas({ carpeta: "relativa" }), /ruta completa/);
  await A.asis_carpetas({ carpeta: join(T, "Mis posts") });
  assert.ok(existsSync(join(T, "Mis posts/Publicaciones/Backlog")));
});
test("marca: valida", async () => {
  await assert.rejects(A.asis_marca({ nombre: "<b>", zona: "UTC", texto_marca: "a" }), /no permitidos/);
  await assert.rejects(A.asis_marca({ nombre: "A", zona: "Nada/Nada", texto_marca: "a" }), /Zona/);
});
test("Buffer: clave inválida no se guarda; canales por ID; la clave no vuelve", async () => {
  globalThis.fetch = async () => resp({}, false, 401);
  await assert.rejects(A.asis_buffer({ clave: "clave-invalida-123" }), /rechazó la clave/);
  assert.ok(!existsSync(process.env.X_CLAVES));
  globalThis.fetch = async (u, o) => {
    if (String(u).includes("bsky.app")) return resp({ handle: "demo.bsky.social" });
    return resp({ data: o.body.includes("organizations") ? { account: { organizations: [{ id: "o" }] } } : { channels: [
      { id: "cx", name: "Demo", service: "twitter" },
      { id: "cb", name: "Demo", service: "bluesky", externalLink: "https://bsky.app/profile/did:plc:abc123" },
      { id: "off", name: "Off", service: "twitter", isDisconnected: true },
    ] } });
  };
  const r = await A.asis_buffer({ clave: "clave-secreta-de-prueba" });
  assert.equal(r.canales.length, 3);
  await assert.rejects(A.asis_canales({ x: "off" }), /desconectado/);
  await assert.rejects(A.asis_canales({ x: "cb" }), /ya no está/);
  await A.asis_canales({ bsky: "cb" });
  assert.deepEqual(redes().map((x) => x.clave), ["bsky"]);
  await A.asis_canales({ x: "cx", bsky: "cb" });
  assert.equal(guardada().publicacion.bluesky.canal.did, "did:plc:abc123");
  assert.ok(!JSON.stringify(await A.asis_estado()).includes("clave-secreta"));
  assert.ok(!readFileSync(process.env.X_CONFIG, "utf8").includes("clave-secreta"));
  assert.ok(nombraMarca("follow demo.bsky.social!", cfg()));
  globalThis.fetch = real;
});
test("alojamiento: crea el espacio, prueba y no manda la clave a otra dirección", async () => {
  const pedidos = [];
  globalThis.fetch = async (u, o = {}) => {
    pedidos.push(`${o.method ?? "GET"} ${u}`);
    return String(u).endsWith("/bucket/fotos") ? resp({}, false, 404) : resp({ public: true });
  };
  await A.asis_imagenes({ url: "https://abc123.supabase.co", clave: "sb_secret_prueba_123", bucket: "fotos" });
  assert.ok(pedidos.includes("POST https://abc123.supabase.co/storage/v1/bucket"));
  assert.ok(pedidos.some((x) => x.startsWith("DELETE")));
  assert.equal(claves().supabase_bucket, "fotos");
  await assert.rejects(A.asis_imagenes({ url: "https://otro.supabase.co", clave: "" }), /pegá también/);
  globalThis.fetch = real;
});
test("horarios", async () => {
  await assert.rejects(A.asis_horarios({ x: "25:00", bsky: "10:00" }), /formato/);
  await A.asis_horarios({ x: "20:00", bsky: "10:00, 11:00" });
  assert.equal(guardada().publicacion.separacion_min, 30);
  assert.equal(guardada().automatizacion.activa, false);
});
test("panel: asistente primero, API cerrada, Host y Origin controlados; después abre el panel", async () => {
  panel = spawn(process.execPath, ["herramientas/panel/servidor.mjs", "--puerto", String(PUERTO)], { cwd: join(import.meta.dirname, ".."), env: process.env });
  await new Promise((ok, mal) => { panel.stdout.once("data", ok); panel.once("exit", () => mal(new Error("el panel no arrancó"))); panel.stderr.on("data", (d) => console.error(String(d))); });
  const B = `http://127.0.0.1:${PUERTO}`, x = { "x-panel": "1", "Content-Type": "application/json" };
  assert.match(await (await fetch(B)).text(), /Configuración inicial/);
  assert.equal((await fetch(`${B}/api/estado`)).status, 409);
  assert.match(await (await fetch(`${B}/prompt.txt`)).text(), /AGENTS\.md/);
  assert.equal((await fetch(`${B}/api/asis_estado`, { method: "POST" })).status, 403);
  assert.equal((await fetch(`${B}/api/asis_estado`, { method: "POST", headers: { ...x, Origin: "https://malo.example" } })).status, 403);
  const host = await new Promise((ok) => request({ host: "127.0.0.1", port: PUERTO, path: "/", headers: { Host: "malo.example" } }, (r) => { r.resume(); ok(r.statusCode); }).end());
  assert.equal(host, 403);
  const c = guardada();
  c.configurado = true;
  c.marca.nombre = "Demo";
  writeFileSync(process.env.X_CONFIG, JSON.stringify(c));
  assert.match(await (await fetch(B)).text(), /<h1>Demo<\/h1>/);
  const e = await fetch(`${B}/api/estado`);
  assert.equal(e.status, 200);
  assert.deepEqual((await e.json()).redes.map((r) => r.clave), ["x", "bsky"]);
});

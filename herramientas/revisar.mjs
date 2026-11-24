// Revisión independiente de un lote (otra corrida de la IA, según docs/instrucciones-revision.md):
// vuelve a mirar cada imagen y cada texto, corrige textos y bloquea lo que no debe salir en X.
// Después corre el control automático de palabras y largo, y asigna fechas.
//   node herramientas/revisar.mjs <carpeta-del-lote>
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { asignarFechas, carpetas, cfg, controlar, guardar, leer, RAIZ } from "./comun.mjs";
import { ejecutarIA } from "./ia.mjs";

export async function revisar(dir) {
  const c = cfg();
  const rutaLote = join(dir, "lote.json");
  const ruta = join(dir, "revision.json");
  rmSync(ruta, { force: true }); // una revisión vieja no vale para un lote que pudo cambiar
  const prompt = [
    `Revisá el lote ${rutaLote} siguiendo al pie de la letra ${join(RAIZ, "docs/instrucciones-revision.md")} (leelas primero, y también ${join(RAIZ, "docs/instrucciones-lote.md")}).`,
    `Las imágenes están en la carpeta del lote (${dir}), en la ruta "imagen" de cada pieza. Abrí cada una.`,
    `Escribí el resultado únicamente en ${ruta}. No modifiques ningún otro archivo. Al terminar respondé solo "LISTO".`,
  ].join("\n");
  console.log(`== Revisión de ${dir}`);
  const codigo = await ejecutarIA(prompt, { herramientas: "Read,Write,Glob", dirs: [carpetas(c).lotes] });
  if (codigo !== 0 || !existsSync(ruta)) throw new Error("La revisión no terminó.");

  const rev = leer(ruta);
  const lote = leer(rutaLote);
  for (const p of lote.piezas) {
    const r = rev.piezas.find((x) => x.n === p.n);
    p.revision = r ? { resultado: r.resultado, observaciones: r.observaciones ?? [] } : { resultado: "sin revisar", observaciones: ["la revisión no incluyó esta pieza"] };
    if (r?.personaje_corregido) p.personaje = r.personaje_corregido;
    if (r?.resultado === "corregir") {
      if (r.texto_corregido) p.texto = r.texto_corregido;
      if (r.alt_corregido) p.alt = r.alt_corregido;
    }
    // La alerta de la redacción solo bloquea si la revisión no la resolvió (escribiendo el texto).
    if (p.alerta && !(r?.resultado === "corregir" && r.texto_corregido)) Object.assign(p, { bloqueada: true, motivo: `Redacción: ${p.alerta}` });
    else if (p.alerta) p.alerta = null;
    if (r?.resultado === "bloquear") Object.assign(p, { bloqueada: true, motivo: `Revisión: ${(r.observaciones ?? []).join("; ")}` });
    if (!r) Object.assign(p, { bloqueada: true, motivo: "La revisión no incluyó esta pieza." });
    p.problemas = p.bloqueada ? [] : controlar(p, c, { lote: lote.lote });
    console.log(`#${p.n} ${p.bloqueada ? "BLOQUEADA: " + p.motivo : p.revision.resultado}${p.problemas.length ? " · control: " + p.problemas.join("; ") : ""}`);
  }
  lote.revisado = new Date().toISOString();
  guardar(rutaLote, lote);
  asignarFechas(dir, c);
  return lote;
}

const dir = process.argv[1]?.endsWith("revisar.mjs") ? process.argv[2] : null;
if (dir) revisar(dir).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });

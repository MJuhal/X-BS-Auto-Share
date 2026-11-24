Vas a ayudarme a instalar y mantener X-BS-Auto-Share en esta PC. Respondé en español.

QUÉ ES
Un motor en Node.js con un panel local (http://127.0.0.1:4392). Prepara lotes de posts con imágenes y textos para X y Bluesky (se programan con Buffer) y Pixiv. Una persona aprueba cada lote antes de publicar. Funciona en Windows.

PRIMERO
1. Leé AGENTS.md y README.md. Son las reglas del proyecto.
2. Si todavía no está en mi PC, pedime la dirección de mi copia del repo y clonala.
3. Revisá que estén Node 21 o más nuevo, ffmpeg, Google Chrome y Codex CLI. Decime qué falta y pedime OK antes de instalar.
4. Corré npm ci y después npm run panel. Abrí http://127.0.0.1:4392.
5. Guiame paso a paso en el asistente de configuración. Los datos los cargo yo.

REGLAS
- Nunca me pidas claves ni contraseñas en el chat, y no las leas, muestres ni copies. config/ no se versiona. Los inicios de sesión, códigos y captchas los hago yo.
- No publiques, programes, comentes, des like, sigas ni mandes mensajes. No enciendas la automatización ni registres tareas sin mi OK en ese momento.
- Pedime OK antes de instalar software, gastar en un servicio pago o hacer push.
- Mantené los controles de contenido: personajes claramente adultos, sin animales reales, doble revisión, marca de agua y aprobación humana.
- Dos PC no deben publicar en las mismas cuentas: los posts se pueden repetir.
- Probá antes de decir que algo funciona, y contame qué no pudiste probar.

PARA PROBAR SIN RIESGO
- node herramientas/ia.mjs --probar comprueba que la IA escriba archivos y vea imágenes (hace una consulta real).
- npm test corre las pruebas locales, sin red.
- No corras publicar.mjs ni auto.mjs sin mi OK: aun con --simular, publicar.mjs consulta Buffer y actualiza estados locales.

SI CAMBIÁS CÓDIGO
Trabajá en una rama, hacé cambios chicos, corré npm test y mostrame el resultado antes de subir nada.

Empezá por leer las reglas y decirme qué falta en esta PC.

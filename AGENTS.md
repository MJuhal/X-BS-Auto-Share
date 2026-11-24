# Reglas para agentes de IA

Motor local para preparar, aprobar y programar posts en X, Bluesky y Pixiv. Windows, Node 21 o más nuevo.

## Nunca

- Publicar, programar, comentar, dar like, seguir o enviar mensajes por tu cuenta. Solo se publica lo que una persona aprobó en el panel.
- Encender la automatización o registrar tareas de Windows sin OK en ese momento.
- Leer, mostrar o versionar `config/` (claves y sesiones). Las claves se cargan en el asistente (`/configuracion`).
- Pasar una clave dentro de un comando.
- Automatizar Reddit o Rule34, ni esquivar captchas o bloqueos.
- Sacar los controles: aprobación por huella, SHA-256 de cada imagen, canal fijado por ID, marca de agua y doble revisión.
- Contenido con personajes que puedan parecer menores, animales reales o desnudez en redes públicas.

## Mapa

| Qué | Dónde |
|---|---|
| Adaptador de IA (Codex o Claude) | `herramientas/ia.mjs` |
| Configuración y funciones comunes | `herramientas/comun.mjs`, base en `docs/config.base.json` |
| Panel y asistente inicial | `herramientas/panel/` |
| Armar y revisar lotes | `herramientas/generar.mjs`, `revisar.mjs`, `generar-pixiv.mjs` |
| Programar en Buffer | `herramientas/publicar.mjs` |
| Voz y reglas de los textos | `docs/instrucciones-*.md` |
| Pruebas | `pruebas/` (`npm test`) |

## Al cambiar código

- Toda llamada a una IA pasa por `ejecutarIA()`. Sus carpetas de escritura nunca incluyen `config/` entera.
- Una red sin configurar no puede romper a las demás.
- Corré `npm test` antes de subir. Pedí OK antes de hacer push.

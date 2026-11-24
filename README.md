# X-BS-Auto-Share

Motor y panel local para preparar, aprobar y programar posts de imagen y texto en **X**, **Bluesky** y **Pixiv**. La IA (Codex o Claude Code) escribe y revisa; una persona aprueba cada lote.

## Instalar

Necesitás Windows, [Node.js](https://nodejs.org) 21 o más nuevo, [ffmpeg](https://ffmpeg.org/download.html), Google Chrome y Codex CLI (`npm install -g @openai/codex`, después `codex login`) o Claude Code.

```
git clone <dirección de tu copia>
cd X-BS-Auto-Share
npm ci
npm run panel
```

Abrí http://127.0.0.1:4392. La primera vez aparece el **asistente de configuración**: pide y prueba la IA, la marca, las carpetas, Buffer, el alojamiento de imágenes y los horarios. Arriba hay un botón para **copiar el prompt para tu agente**. Después alcanza con abrir `Abrir-panel.vbs`.

## Qué cuentas hacen falta

| Servicio | Para qué | ¿Obligatorio? |
|---|---|---|
| Buffer | Programar en X y Bluesky | Sí |
| Supabase | Dar una dirección pública a cada imagen (Buffer no recibe archivos) | Sí |
| Codex o Claude Code | Escribir y revisar | Sí, uno |
| Pixiv | Subir posts de 3 imágenes | No |
| API de X (paga) y Rule34 | Sorteos y análisis | No |

Las claves quedan en `config/claves.json`, en tu PC y fuera de git.

## Cómo se usa

1. Dejá imágenes en `Publicaciones/Backlog` (`personaje-sfw-cute-1.png`). Los archivos con "nsfw" en el nombre se saltean.
2. En el panel, **Generar lote**: la IA escribe cada texto y otra corrida lo revisa.
3. Revisá, editá y **aprobá**.
4. **Programar**: los posts pasan a Buffer. Con la automatización encendida, se programa todos los días a las 8:00.

Si otra PC publica en las mismas cuentas, los posts pueden repetirse: usá cuentas propias.

## Desarrollo

`npm test` corre las pruebas locales, sin red. Las reglas para agentes están en [AGENTS.md](AGENTS.md).

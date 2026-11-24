# Sorteos (X, Bluesky y Pixiv)

Sección **Sorteos** del panel, en las pestañas X, Bluesky y Pixiv. Código: `herramientas/sorteo.mjs` (y `herramientas/x-api.mjs` para X).

El panel solo **lee** quién participó y elige al azar. No publica, no da like, no sigue ni manda mensajes:
- el post del sorteo sale como cualquier otro, en un lote aprobado;
- al ganador le escribe la persona a cargo, a mano, desde la cuenta de marca.

## Flujo

1. Publicar el post del sorteo con las bases: premio, condiciones, fecha de cierre, cómo se avisa al ganador y "solo mayores de 18" si el premio da acceso a contenido adulto.
2. En el panel: **Nuevo sorteo**. Cargar el nombre, el link del post (vacío = sorteo entre todos los seguidores), las condiciones, la cantidad de ganadores y suplentes, la antigüedad mínima de la cuenta y el cierre.
3. Al cierre: **Revisar participantes**. Trae a todos y marca quién cumple. Quedan afuera la cuenta propia, las cuentas sin posts (posibles bots) y las cuentas más nuevas que el mínimo.
4. **Sortear**. Elige ganadores y suplentes y deja todo registrado en `config/sorteos/<id>.md` (botón **Ver registro**).
5. **Finalizar ahora** hace los pasos 3 y 4 de un solo toque, con los participantes de ese momento. Sirve para cerrar antes de la fecha cargada: el cierre del panel es solo informativo. Ojo con las bases del post: si dicen 3 días, cerrá cuando dicen o publicá antes el cierre real.
6. Si el ganador no responde en el plazo de las bases, se pasa al primer suplente.

**Cómo se verifica:** a cada cuenta que cumple se le calcula `sha256("semilla:id")` y se ordenan de menor a mayor. Los primeros son los ganadores y siguen los suplentes. Con la semilla y la lista del registro, cualquiera puede rehacer el sorteo.

## Qué se puede pedir en cada red

| Red | Comentó | Like | Repost | Favoritos | Te sigue | Antigüedad | Costo |
|---|---|---|---|---|---|---|---|
| Bluesky | sí | sí | sí | no aplica | sí | sí | gratis (API pública) |
| Pixiv | sí | no (anónimos) | no existe | sí, solo públicos | sí | no | gratis (sesión del Chrome de Pixiv, solo lectura) |
| X | sí, hasta 7 días | sí | sí | no aplica | sí | sí | pago por uso |

En Pixiv no se puede revisar mientras se está publicando un post: los dos usan el mismo Chrome. Si pasa, se reintenta a los minutos.

## X: puesta en marcha (una sola vez, la hace la persona a cargo)

La API de X se paga por uso. la persona a cargo crea la cuenta y carga el saldo. La IA no crea cuentas, no paga ni acepta términos.

1. Entrar a https://developer.x.com con la cuenta de la marca y crear un proyecto con una app. Cargar saldo (pay-per-use; alcanza con 5 a 10 USD).
2. En la app, **User authentication settings**:
   - permisos: **Read**;
   - tipo: **Web App, Automated App or Bot** (cliente confidencial);
   - Callback URI: `http://127.0.0.1:8766/callback`;
   - Website: cualquier URL propia (por ejemplo, el Patreon).
3. Copiar el **Client ID** y el **Client Secret** de OAuth 2.0 en el archivo de claves (el mismo de Buffer, `publicacion.publicador` en `config/x.json`, fuera del repo) con estos nombres:
   `"x_client_id": "..."` y `"x_client_secret": "..."`.
   Nunca en un archivo del repo ni escritos en un comando.
4. En el panel, pestaña X: **Conectar X**. Se abre el navegador, la persona a cargo autoriza la app con la cuenta de la marca y la sesión queda en `config/x-api-sesion.json`.

### Costo (docs.x.com, 2026-11-18)

| Lectura | Precio |
|---|---|
| Post leído (respuestas) | 0,005 USD |
| Usuario leído (likes, reposts) | 0,010 USD |
| Seguidores propios | 0,001 USD |

- Lo que se repite en el mismo día UTC no se cobra dos veces.
- Antes de revisar, **Calcular costo** lee el post y la cuenta (unos centavos) y estima el total con un 20 % de margen.
- **Revisar** pide confirmar ese monto cada vez.
- Ejemplo: 150 likes, 40 respuestas y 500 seguidores dan unos 3 USD.

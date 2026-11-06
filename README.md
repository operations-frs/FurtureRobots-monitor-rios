# Monitor de caudales CHIRILU

El proyecto incluye una aplicación local en Python y un despliegue Cloudflare Worker. Ambos consultan datos publicados por SENAMHI para las estaciones Antapucro (Lurín), Chosica (Rímac) y Obrajillo (Chillón).

La interfaz separa estructura, estilos y comportamiento en `web/index.html`, `web/styles.css` y `web/app.js`.

## Iniciar

1. Instala Python 3.9 o superior si aún no está instalado.
2. Haz doble clic en `iniciar.bat`.
3. Espera el mensaje `Monitor CHIRILU listo en http://127.0.0.1:8000`.
4. Abre [http://127.0.0.1:8000](http://127.0.0.1:8000) en el navegador.

No abras `web/index.html` directamente: al abrirlo como archivo local se muestra el aviso para iniciar el servidor, pero no se pueden consultar los caudales.

También puedes iniciarlo desde PowerShell, en esta carpeta, con `python app.py`.
Presiona `Ctrl+C` en la ventana para cerrar el servidor.

## Cloudflare Worker

El Worker está en `src/worker.js`; `wrangler.toml` configura D1, los Assets estáticos de `web/` y la actualización automática cada 20 minutos.

El Worker está publicado en [monitor-rios.operations-9ae.workers.dev](https://monitor-rios.operations-9ae.workers.dev). La base `monitor-rios-db` ya está creada y su `database_id` está configurado en `wrangler.toml`.

- Para crear una base local nueva, ejecuta `wrangler d1 execute monitor-rios-db --local --file=schema.sql` y luego `wrangler dev`. Para una base existente, aplica cada migración de `migrations/` una sola vez.
- Para aplicar cambios al esquema remoto, ejecuta las sentencias de la migración con `wrangler d1 execute monitor-rios-db --remote --command "..."` o con `--file` si tu cuenta permite importar archivos SQL.
- Para publicar cambios, ejecuta `wrangler deploy`. Si despliegas desde otra cuenta Cloudflare, crea allí `monitor-rios-db`, reemplaza el `database_id` y vuelve a aplicar `schema.sql`.
- Para activar los resúmenes, guarda la clave REST privada de OneSignal con `wrangler secret put ONESIGNAL_REST_API_KEY`. La clave se usa solo desde el Worker y los envíos se dirigen a usuarios suscritos.

El Worker conserva los endpoints `GET /api/status` y `POST /api/refresh`. El primero solo lee D1; el segundo consulta SENAMHI y guarda el último estado. El Cron Trigger también consulta SENAMHI cada 20 minutos.

## Cómo funciona

- Lee el caudal y las últimas 12 observaciones de los gráficos horarios de Chosica, Obrajillo y Antapucro.
- Consulta los gráficos y los umbrales oficiales de SENAMHI al iniciar y luego cada 20 minutos. Puede repetir el mismo caudal hasta que la estación publique el siguiente dato horario.
- La versión local en Python guarda la última lectura válida en `data/estado.json`; el Worker guarda el estado en D1. Si una consulta falla, ambos conservan la última lectura válida e informan el error.
- La página muestra minigráficos y niveles visuales Normal, Precaución y Peligro calculados con los umbrales amarillo (75%), naranja (90%) y rojo. No envía notificaciones por llegar a esos niveles ni reemplaza una alerta oficial.
- Si se configura la clave privada de OneSignal, el Worker envía resúmenes a las 07:00, 15:20 y 22:00 (hora de Lima). Si algún río llega al 75% del umbral rojo, el mensaje pide tomar precauciones y nombra esos ríos; si ninguno lo alcanza, dice “Todo tranquilo por ahora”.

La extracción depende del endpoint público de SENAMHI y podría requerir ajustes si el sitio cambia.

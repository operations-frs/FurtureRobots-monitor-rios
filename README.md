# Monitor local de caudales CHIRILU

Aplicación local en Python que consulta los datos publicados por SENAMHI para las estaciones Antapucro (Lurín), Chosica (Rímac) y Obrajillo (Chillón).

La interfaz separa estructura, estilos y comportamiento en `web/index.html`, `web/styles.css` y `web/app.js`.

## Iniciar

1. Instala Python 3.9 o superior si aún no está instalado.
2. Haz doble clic en `iniciar.bat`.
3. Espera el mensaje `Monitor CHIRILU listo en http://127.0.0.1:8000`.
4. Abre [http://127.0.0.1:8000](http://127.0.0.1:8000) en el navegador.

No abras `web/index.html` directamente: al abrirlo como archivo local se muestra el aviso para iniciar el servidor, pero no se pueden consultar los caudales.

También puedes iniciarlo desde PowerShell, en esta carpeta, con `python app.py`.
Presiona `Ctrl+C` en la ventana para cerrar el servidor.

## Cómo funciona

- Lee el caudal y la hora más reciente de los gráficos horarios de Chosica, Obrajillo y Antapucro.
- Consulta los gráficos y los umbrales oficiales de SENAMHI al iniciar y luego cada 20 minutos. Puede repetir la misma lectura hasta que la estación publique el siguiente dato horario.
- Marca la lectura como desactualizada si tiene más de 90 minutos, y muestra siempre la hora reportada por la estación.
- Guarda la última lectura válida en `data/estado.json`; si una consulta falla, conserva esa lectura e informa el error.
- La etiqueta de estado compara el caudal reportado con el umbral rojo de la propia tabla de SENAMHI. No envía alertas ni reemplaza una alerta oficial.

La extracción depende del endpoint público de SENAMHI y podría requerir ajustes si el sitio cambia.

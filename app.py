"""Monitor local de caudales CHIRILU usando el endpoint público de SENAMHI."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen


BASE_DIR = Path(__file__).resolve().parent
STATE_FILE = BASE_DIR / "data" / "estado.json"
WEB_DIR = BASE_DIR / "web"
STATIC_ASSETS = {
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
SITE_ROOT = "https://www.senamhi.gob.pe/"
GRAPH_URL = urljoin(SITE_ROOT, "include/ajax-idesep-chirilu.php")
SOURCE_PAGE = "https://www.senamhi.gob.pe/?dp=piura&p=monitoreo-chirilu"
POLL_SECONDS = 20 * 60
# Perú usa UTC-5 durante todo el año; esto funciona también en Windows sin tzdata.
TIMEZONE = timezone(timedelta(hours=-5), "PET")

STATIONS = {
    "ANTAPUCRO": ("Lurín", "Antapucro", "antapucro_m"),
    "CHOSICA": ("Rímac", "Chosica", "chosica_m"),
    "OBRAJILLO": ("Chillón", "Obrajillo", "obrajillo_m"),
}

_state_lock = threading.RLock()
_refresh_lock = threading.Lock()
_state = {
    "datos": [],
    "consultado_en": None,
    "error": "Aún no hay datos descargados.",
}


def _load_state() -> None:
    global _state
    try:
        with STATE_FILE.open("r", encoding="utf-8") as file:
            saved = json.load(file)
        if isinstance(saved, dict):
            _state.update(saved)
    except (OSError, json.JSONDecodeError):
        pass


def _save_state() -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(_state, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(STATE_FILE)


def _number(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _extract_chart_data(html: str) -> dict:
    marker = "var data = "
    start = html.find(marker)
    if start < 0:
        raise ValueError("No se encontró la serie de datos del gráfico de SENAMHI.")
    start += len(marker)

    # Cuenta llaves para extraer solo el objeto, incluso si trae arreglos de umbrales anidados.
    depth = 0
    in_string = False
    escaped = False
    end = None
    for position in range(start, len(html)):
        char = html[position]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                end = position + 1
                break
    if end is None:
        raise ValueError("No se pudo delimitar la serie horaria del gráfico.")

    json_text = html[start:end]
    try:
        return json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise ValueError("La serie horaria recibida no tiene formato JSON válido.") from exc


def _read_hourly_station(station_name: str, now: datetime) -> dict:
    river, station_label, graph_key = STATIONS[station_name]
    payload = urlencode({"estacion": graph_key}).encode()
    request = Request(
        GRAPH_URL,
        data=payload,
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "Monitor-Local-CHIRILU/1.0",
            "Referer": SOURCE_PAGE,
        },
        method="POST",
    )
    with urlopen(request, timeout=25) as response:
        chart_path = json.loads(response.read().decode("utf-8"))
    if not isinstance(chart_path, str) or not chart_path:
        raise ValueError(f"SENAMHI no devolvió el gráfico de {station_label}.")

    # La ruta retornada por SENAMHI incluye un espacio antes de &variable.
    chart_url = urljoin(SITE_ROOT, chart_path.replace(" ", "%20"))
    chart_request = Request(
        chart_url,
        headers={"User-Agent": "Monitor-Local-CHIRILU/1.0", "Referer": SOURCE_PAGE},
    )
    with urlopen(chart_request, timeout=25) as response:
        html = response.read().decode("utf-8", errors="replace")
    series = _extract_chart_data(html)

    now_timestamp = now.timestamp() * 1000
    observations = []
    for point in series.get("dato", []):
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        timestamp_ms = _number(point[0])
        flow = _number(point[1])
        if timestamp_ms is not None and flow is not None and timestamp_ms <= now_timestamp:
            observations.append((timestamp_ms, flow))
    if not observations:
        raise ValueError(f"El gráfico de {station_label} no contiene caudales horarios válidos.")

    timestamp_ms, flow = max(observations, key=lambda point: point[0])
    return {
        "rio": river,
        "estacion": station_label,
        "caudal": flow,
        "unidad": series.get("unidad") or "m³/s",
    }


def refresh_data() -> dict:
    """Lee los caudales horarios del gráfico y conserva el último éxito."""
    if not _refresh_lock.acquire(blocking=False):
        with _state_lock:
            return dict(_state)

    try:
        now = datetime.now(TIMEZONE)
        rows = [
            _read_hourly_station(station, now)
            for station in STATIONS
        ]

        with _state_lock:
            _state.update(
                {
                    "datos": rows,
                    "consultado_en": now.isoformat(timespec="seconds"),
                    "error": None,
                }
            )
            _save_state()
            return dict(_state)
    except (URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
        with _state_lock:
            _state["error"] = f"No se pudo actualizar desde SENAMHI: {exc}"
            _save_state()
            return dict(_state)
    finally:
        _refresh_lock.release()


def _poll_forever() -> None:
    while True:
        time.sleep(POLL_SECONDS)
        refresh_data()


class RequestHandler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/api/status":
            with _state_lock:
                body = json.dumps(_state, ensure_ascii=False).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
            return
        if self.path in STATIC_ASSETS:
            file_name, content_type = STATIC_ASSETS[self.path]
            try:
                body = (WEB_DIR / file_name).read_bytes()
            except OSError:
                self._send(500, b"No se encuentra un archivo estatico", "text/plain; charset=utf-8")
                return
            self._send(200, body, content_type)
            return
        if self.path in ("/", "/index.html"):
            try:
                body = (WEB_DIR / "index.html").read_bytes()
            except OSError:
                self._send(500, b"No se encuentra web/index.html", "text/plain; charset=utf-8")
                return
            self._send(200, body, "text/html; charset=utf-8")
            return
        self._send(404, b"No encontrado", "text/plain; charset=utf-8")

    def do_POST(self) -> None:
        if self.path != "/api/refresh":
            self._send(404, b"No encontrado", "text/plain; charset=utf-8")
            return
        state = refresh_data()
        body = json.dumps(state, ensure_ascii=False).encode("utf-8")
        self._send(200, body, "application/json; charset=utf-8")

    def log_message(self, format: str, *args) -> None:
        print(f"[{datetime.now(TIMEZONE):%H:%M:%S}] {format % args}")


def main() -> None:
    _load_state()
    refresh_data()
    threading.Thread(target=_poll_forever, daemon=True, name="senamhi-poller").start()
    server = ThreadingHTTPServer(("127.0.0.1", 8000), RequestHandler)
    print("Monitor CHIRILU listo en http://127.0.0.1:8000")
    print("Consulta SENAMHI cada 20 minutos mientras esta ventana siga abierta.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nCerrando monitor...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

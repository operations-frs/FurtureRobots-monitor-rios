CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL,
  historial_caudales TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chart_paths (
  station_key TEXT PRIMARY KEY,
  chart_path TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_digest_runs (
  local_date TEXT PRIMARY KEY,
  local_hour TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TEXT
);

INSERT OR IGNORE INTO app_state (id, state_json, updated_at)
VALUES (
  1,
  '{"datos":[],"consultado_en":null,"error":"Aún no hay datos descargados."}',
  CURRENT_TIMESTAMP
);

ALTER TABLE app_state
ADD COLUMN historial_caudales TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS daily_digest_runs (
  local_date TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  sent_at TEXT
);

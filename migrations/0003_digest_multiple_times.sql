CREATE TABLE daily_digest_runs_v2 (
  local_date TEXT NOT NULL,
  local_hour TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (local_date, local_hour)
);

INSERT OR IGNORE INTO daily_digest_runs_v2 (local_date, local_hour, status, sent_at)
SELECT local_date, '08', status, sent_at FROM daily_digest_runs;

DROP TABLE daily_digest_runs;
ALTER TABLE daily_digest_runs_v2 RENAME TO daily_digest_runs;

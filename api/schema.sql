-- Short links for The Baddie Times Customizer.
CREATE TABLE IF NOT EXISTS papers (
  name       TEXT PRIMARY KEY,          -- the short link, e.g. "slogantimes"
  cfg        TEXT NOT NULL,             -- the reader's picks, e.g. "#n=Slogan%20Times&s=..."
  code_hash  TEXT NOT NULL,             -- SHA-256 of the private edit code
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ip_hash    TEXT                       -- hashed IP, only for the daily claim limit
);
CREATE INDEX IF NOT EXISTS papers_ip_day ON papers (ip_hash, created_at);

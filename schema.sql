-- Reference copy of the DDL embedded in the Worker's migration runner
-- (see src/db.ts). The Worker applies these statements lazily at runtime with
-- CREATE ... IF NOT EXISTS, so there is no manual SQL step for the operator.
-- Kept here for humans and tooling; it is not executed directly in production.

-- Note: ids ('dec-001', ...) are generated per project+kind and therefore
-- repeat across projects, so the primary key is composite (project, id) rather
-- than id alone. This corrects the single-project assumption in the original
-- reference DDL now that one table holds many projects.
CREATE TABLE IF NOT EXISTS entries (
  id TEXT NOT NULL,             -- 'dec-001', 'pipe-003', 'con-012' (keep this format)
  kind TEXT NOT NULL,           -- 'decision' | 'pipeline' | 'constraint'
  project TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'deprecated'
  created_at TEXT NOT NULL,     -- ISO 8601 UTC
  updated_at TEXT NOT NULL,
  superseded_by TEXT,
  payload TEXT NOT NULL,        -- entry JSON, schema-flexible
  PRIMARY KEY (project, id)
);

CREATE INDEX IF NOT EXISTS idx_entries_pks ON entries(project, kind, status);

CREATE TABLE IF NOT EXISTS config (
  project TEXT,
  key TEXT,
  value TEXT,
  PRIMARY KEY (project, key)
);

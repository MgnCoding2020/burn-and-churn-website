-- Phase 7: the SharePoint sync (plan §5; ADR-0039). Times are Unix epoch milliseconds.
--
-- SharePoint is the system of record; the website keeps a published copy and never writes
-- back. Each list's last good copy is one validated JSON document: a list that fails to
-- read, or whose rows all fail validation, keeps its previous copy.
CREATE TABLE sharepoint_snapshots (
  list         TEXT PRIMARY KEY,                    -- contract list name, e.g. Menu
  data         TEXT NOT NULL,                       -- validated JSON, the shape the site uses
  item_count   INTEGER NOT NULL,
  synced_at    INTEGER NOT NULL,
  run_id       TEXT NOT NULL
);

-- One row per sync: the 15-minute cron, or a manager's Publish.
CREATE TABLE sync_runs (
  id            TEXT PRIMARY KEY,                   -- random UUID
  trigger_kind  TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'publish')),
  triggered_by  TEXT REFERENCES users (id),         -- the manager, for Publish
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  summary       TEXT                                -- JSON per list: read, published, rejected rows with reasons
);
CREATE INDEX sync_runs_started ON sync_runs (started_at);

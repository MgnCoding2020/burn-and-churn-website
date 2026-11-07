-- Phase 2: people who sign in, their sessions, and the audit log (plan §4, §11; ADR-0024).
-- Applied with: npx wrangler d1 migrations apply DB  (--local for development)

-- One row per person per directory. Staff (workforce) and customers can never share a row.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,                       -- random UUID, ours
  idp           TEXT NOT NULL CHECK (idp IN ('workforce', 'customer')),
  idp_sub       TEXT NOT NULL,                          -- the directory's stable subject ID
  display_name  TEXT NOT NULL,
  role          TEXT CHECK (role IS NULL OR role IN ('Staff.Barista', 'Staff.ShiftLead', 'Staff.Manager', 'Staff.Owner')),
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  UNIQUE (idp, idp_sub)
);

-- Server-side sessions. Only a SHA-256 hash of the session token is stored, so a copy of
-- this table can't be used to sign in. Times are Unix epoch milliseconds.
CREATE TABLE sessions (
  id_hash          TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idp              TEXT NOT NULL CHECK (idp IN ('workforce', 'customer')),
  role             TEXT,                                -- role at sign-in; changes apply at next sign-in
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,                    -- absolute limit
  idle_expires_at  INTEGER NOT NULL,                    -- slides forward on use, never past expires_at
  idle_ms          INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- Who did what. Insert-only: the triggers below refuse any change or deletion (AU-9).
CREATE TABLE audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  actor_user_id  TEXT,
  actor_role     TEXT,
  action         TEXT NOT NULL,
  target         TEXT,
  before         TEXT,                                  -- JSON, when something changed
  after          TEXT
);
CREATE INDEX audit_log_at ON audit_log (at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is insert-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is insert-only');
END;

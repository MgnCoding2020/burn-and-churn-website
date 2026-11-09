-- Phase 3: the restock chain (ADR-0033). Times are Unix epoch milliseconds.
--
-- A sold-out item now stays sold out until its restock is received, its marker
-- undoes it within 5 minutes, or a Manager overrides with a reason. The old
-- per-day mark (sold_out_on) is dropped: every item starts available.
ALTER TABLE item_availability ADD COLUMN sold_out_at INTEGER;          -- NULL when available
ALTER TABLE item_availability ADD COLUMN sold_out_by TEXT REFERENCES users (id);
ALTER TABLE item_availability DROP COLUMN sold_out_on;

-- Restock requests gain approval and receipt. SQLite can't change a CHECK
-- constraint in place, so the table is rebuilt. Old done rows become received;
-- old open rows are closed as rejected with a reason, since every item starts
-- available again (and the old API allowed several open rows per item).
PRAGMA defer_foreign_keys = on;

CREATE TABLE restock_requests_new (
  id               TEXT PRIMARY KEY,                -- random UUID
  item_id          TEXT NOT NULL,
  quantity         TEXT NOT NULL,                   -- free text, e.g. "2 bags", "1 case"
  note             TEXT,
  status           TEXT NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'approved', 'rejected', 'received')),
  requested_by     TEXT NOT NULL REFERENCES users (id),
  requested_at     INTEGER NOT NULL,
  decided_by       TEXT REFERENCES users (id),      -- the Manager+ who approved or rejected
  decided_at       INTEGER,
  decision_reason  TEXT,                            -- required when rejected
  received_by      TEXT REFERENCES users (id),
  received_at      INTEGER
);

INSERT INTO restock_requests_new
  (id, item_id, quantity, note, status, requested_by, requested_at, decision_reason,
   received_by, received_at)
SELECT id, item_id, quantity, note,
       CASE status WHEN 'done' THEN 'received' ELSE 'rejected' END,
       requested_by, requested_at,
       CASE status WHEN 'done' THEN NULL ELSE 'Closed by migration 0005 (restock chain)' END,
       done_by, done_at
FROM restock_requests;

DROP TABLE restock_requests;
ALTER TABLE restock_requests_new RENAME TO restock_requests;
CREATE INDEX restock_status ON restock_requests (status, requested_at);
-- At most one live request (requested or approved) per item.
CREATE UNIQUE INDEX restock_one_live ON restock_requests (item_id)
  WHERE status IN ('requested', 'approved');

-- Phase 3: "86" an item for the day, and restock requests (plan §4.4; ADR-0032).
-- Times are Unix epoch milliseconds.

-- An item is sold out while sold_out_on is today's business day (store time
-- zone), so it comes back on its own the next day: no nightly job to forget.
CREATE TABLE item_availability (
  item_id      TEXT PRIMARY KEY,                    -- the menu item's id
  sold_out_on  TEXT,                                -- YYYY-MM-DD, or NULL when available
  changed_by   TEXT REFERENCES users (id),
  changed_at   INTEGER NOT NULL
);

-- A manager's request to restock a sold-out item. Stock levels themselves
-- arrive with the SharePoint Inventory list (Phase 7).
CREATE TABLE restock_requests (
  id            TEXT PRIMARY KEY,                   -- random UUID
  item_id       TEXT NOT NULL,
  quantity      TEXT NOT NULL,                      -- free text, e.g. "2 bags", "1 case"
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  requested_by  TEXT NOT NULL REFERENCES users (id),
  requested_at  INTEGER NOT NULL,
  done_by       TEXT REFERENCES users (id),
  done_at       INTEGER
);
CREATE INDEX restock_open ON restock_requests (status, requested_at);

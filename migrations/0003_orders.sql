-- Phase 3: counter orders and the order board (plan §6.3, §11; ADR-0031).
-- Prices are copied into each line at sale time, so later menu changes never
-- rewrite history. Times are Unix epoch milliseconds.

CREATE TABLE orders (
  id               TEXT PRIMARY KEY,                    -- random UUID
  business_day     TEXT NOT NULL,                       -- YYYY-MM-DD in the store's time zone
  number           INTEGER NOT NULL,                    -- shown on the board; restarts each business day
  channel          TEXT NOT NULL CHECK (channel IN ('counter', 'online')),
  tender           TEXT NOT NULL CHECK (tender IN ('cash', 'card')),
  stage            TEXT NOT NULL DEFAULT 'new'
                   CHECK (stage IN ('new', 'in_progress', 'ready', 'collected')),
  payment          TEXT NOT NULL DEFAULT 'paid' CHECK (payment IN ('paid', 'refunded')),
  total_cents      INTEGER NOT NULL CHECK (total_cents > 0),
  tendered_cents   INTEGER CHECK (tendered_cents IS NULL OR tendered_cents >= total_cents),
  change_cents     INTEGER CHECK (change_cents IS NULL OR change_cents >= 0),
  taken_by         TEXT REFERENCES users (id),          -- who took the payment (separation of duties)
  idempotency_key  TEXT NOT NULL UNIQUE,                -- a double-tap can't record a sale twice
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (business_day, number)
);
CREATE INDEX orders_board ON orders (business_day, stage);
CREATE INDEX orders_taken_by ON orders (taken_by, created_at);

CREATE TABLE order_items (
  order_id          TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  line              INTEGER NOT NULL,
  item_id           TEXT NOT NULL,
  variant_id        TEXT NOT NULL,
  name              TEXT NOT NULL,                      -- as sold, e.g. "Latte"
  variant_label     TEXT NOT NULL,                      -- as sold, e.g. "16 oz"
  qty               INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 20),
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  PRIMARY KEY (order_id, line)
);

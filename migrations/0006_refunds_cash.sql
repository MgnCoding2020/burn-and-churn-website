-- Phase 3: refunds and the end-of-shift cash count (plan §4.4, §6.3, §11; ADR-0034).
-- Amounts are integer cents; times are Unix epoch milliseconds.

-- A refund of a whole sale or of some of its lines. Amounts come from the
-- order's own lines, never typed. Stripe columns are ready for Phase 4.
CREATE TABLE refunds (
  id                TEXT PRIMARY KEY,                     -- random UUID
  order_id          TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  tender            TEXT NOT NULL CHECK (tender IN ('cash', 'card')),
  reason_code       TEXT NOT NULL,
  reason_note       TEXT,
  issued_by         TEXT NOT NULL REFERENCES users (id),  -- never the person who took the payment, unless Owner
  idempotency_key   TEXT NOT NULL UNIQUE,                 -- a double-tap can't refund twice
  status            TEXT NOT NULL DEFAULT 'succeeded'
                    CHECK (status IN ('pending', 'succeeded', 'failed')),
  stripe_refund_id  TEXT,                                 -- Phase 4 (card refunds)
  created_at        INTEGER NOT NULL
);
CREATE INDEX refunds_order ON refunds (order_id);
CREATE INDEX refunds_created ON refunds (created_at);

CREATE TABLE refund_lines (
  refund_id     TEXT NOT NULL REFERENCES refunds (id) ON DELETE CASCADE,
  order_id      TEXT NOT NULL,
  line          INTEGER NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty >= 1),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (refund_id, line),
  FOREIGN KEY (order_id, line) REFERENCES order_items (order_id, line) ON DELETE CASCADE
);
CREATE INDEX refund_lines_order ON refund_lines (order_id, line);

-- Never refund more of a line than was sold, even if two managers refund at
-- once: the whole refund (one transaction) is aborted.
CREATE TRIGGER refund_lines_not_over
BEFORE INSERT ON refund_lines
WHEN NEW.qty + COALESCE(
       (SELECT SUM(qty) FROM refund_lines WHERE order_id = NEW.order_id AND line = NEW.line), 0)
     > (SELECT qty FROM order_items WHERE order_id = NEW.order_id AND line = NEW.line)
BEGIN
  SELECT RAISE(ABORT, 'over_refund');
END;

-- The cash drawer for one shift: a float at open, a blind count at close.
CREATE TABLE cash_drawers (
  id                  TEXT PRIMARY KEY,                   -- random UUID
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  float_cents         INTEGER NOT NULL CHECK (float_cents BETWEEN 0 AND 100000),
  opened_by           TEXT NOT NULL REFERENCES users (id),
  opened_at           INTEGER NOT NULL,
  closed_by           TEXT REFERENCES users (id),
  closed_at           INTEGER,
  cash_sales_cents    INTEGER,                            -- cash sales while open
  cash_refunds_cents  INTEGER,                            -- cash refunds while open
  expected_cents      INTEGER,                            -- float + sales - refunds
  counted_cents       INTEGER,
  variance_cents      INTEGER,                            -- counted - expected
  counts              TEXT,                               -- JSON: denomination (cents) -> how many
  reason_code         TEXT,                               -- why the count was off, if it was by more than $5
  reason_note         TEXT,
  explained_by        TEXT REFERENCES users (id),
  reviewed_by         TEXT REFERENCES users (id),         -- a Manager+, never the closer unless Owner
  reviewed_at         INTEGER
);
-- One drawer open at a time.
CREATE UNIQUE INDEX cash_drawers_one_open ON cash_drawers (status) WHERE status = 'open';
CREATE INDEX cash_drawers_opened ON cash_drawers (opened_at);

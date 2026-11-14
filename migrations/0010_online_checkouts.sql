-- Phase 5: online orders paid with Stripe Checkout (plan §6.1; ADR-0044).
-- Amounts are integer cents; times are Unix epoch milliseconds.
--
-- A checkout is an attempt, like a counter card payment (0008): the order
-- exists only once Stripe confirms payment, so an abandoned or expired
-- checkout never reaches the board. No card details are ever stored: the
-- customer types them on Stripe's own page.
CREATE TABLE online_checkouts (
  id                 TEXT PRIMARY KEY,                    -- random UUID; Stripe's client_reference_id
  idempotency_key    TEXT NOT NULL UNIQUE,                -- a double-click can't start two checkouts
  user_id            TEXT REFERENCES users (id) ON DELETE SET NULL, -- the customer; cleared by Delete my data
  session_id         TEXT UNIQUE,                         -- cs_test_..., set once Stripe has it
  url                TEXT,                                -- Stripe's payment page, for a repeated request
  status             TEXT NOT NULL DEFAULT 'starting'
                     CHECK (status IN ('starting', 'open', 'paid', 'expired', 'failed')),
  total_cents        INTEGER NOT NULL CHECK (total_cents > 0),
  lines              TEXT NOT NULL,                       -- JSON: the priced lines, as at checkout
  payment_intent_id  TEXT,                                -- pi_..., once paid (refunds use it)
  order_id           TEXT REFERENCES orders (id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL
);
CREATE INDEX online_checkouts_user ON online_checkouts (user_id, created_at);
CREATE INDEX online_checkouts_created ON online_checkouts (created_at);

-- Which customer an online order belongs to. Cleared, not deleted, by
-- Delete my data: the shop keeps the sale, unlinked (Owner, 2026-11-14).
ALTER TABLE orders ADD COLUMN customer_id TEXT REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX orders_customer ON orders (customer_id, created_at);

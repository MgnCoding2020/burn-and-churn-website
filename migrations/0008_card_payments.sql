-- Phase 4: card payments at the counter through Stripe Terminal's simulated
-- reader (plan §6.2; ADR-0036). Amounts are integer cents; times are Unix epoch milliseconds.
--
-- A card payment is an attempt: the order exists only once Stripe says the
-- payment succeeded, so a declined or abandoned card never appears on the
-- board or in the drawer. No card details are ever stored: only Stripe's IDs
-- and its decline code.
CREATE TABLE card_payments (
  id                 TEXT PRIMARY KEY,                    -- random UUID
  idempotency_key    TEXT NOT NULL UNIQUE,                -- a double-tap can't start two payments
  payment_intent_id  TEXT UNIQUE,                         -- pi_..., set once Stripe has it
  reader_id          TEXT NOT NULL,                       -- tmr_...
  status             TEXT NOT NULL DEFAULT 'starting'
                     CHECK (status IN ('starting', 'waiting', 'declined', 'succeeded', 'canceled', 'failed')),
  total_cents        INTEGER NOT NULL CHECK (total_cents > 0),
  lines              TEXT NOT NULL,                       -- JSON: the priced lines, as rung up
  taken_by           TEXT NOT NULL REFERENCES users (id),
  taken_by_role      TEXT NOT NULL,
  failure_code       TEXT,                                -- e.g. card_declined (Stripe's code, not card data)
  order_id           TEXT REFERENCES orders (id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX card_payments_created ON card_payments (created_at);

-- The order a card payment became. Unique, so a webhook and the register's
-- own status check arriving together can't create the order twice.
ALTER TABLE orders ADD COLUMN payment_intent_id TEXT;
CREATE UNIQUE INDEX orders_payment_intent ON orders (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

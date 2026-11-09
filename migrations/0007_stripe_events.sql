-- Phase 4: Stripe webhook events (plan §6.1, §11; ADR-0035). Times are Unix epoch milliseconds.
--
-- One row per Stripe event, written only after its signature is verified.
-- The primary key makes each event processed once: a replay or Stripe's own
-- retry of an event already seen changes nothing. Only the ID, type and
-- outcome are kept, never the payload. Deleted after 90 days.
CREATE TABLE stripe_events (
  event_id      TEXT PRIMARY KEY,                    -- evt_...
  type          TEXT NOT NULL,                       -- e.g. terminal.reader.action_succeeded
  created       INTEGER NOT NULL,                    -- when Stripe created it
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER,
  outcome       TEXT                                 -- what this site did with it, e.g. "ignored"
);
CREATE INDEX stripe_events_received ON stripe_events (received_at);

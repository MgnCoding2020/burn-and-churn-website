# ADR-0036: Card payments at the counter (Stripe Terminal, simulated reader)

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Phase 4 (plan §6.2): the register takes cards through Stripe Terminal's server-driven integration, with Stripe's **simulated reader** (no hardware, test mode). The library, keys and webhooks are in ADR-0035.

Michael's decision (2026-11-09): **"Simulate tap" is available to every staff role**, in test mode only, labelled as a test, and audited. A real customer would tap their own card, so a barista must be able to finish a card sale alone.

The flow was checked against Stripe's documentation on 2026-11-09:

- create a PaymentIntent (`card_present`; this API version names the parameter `allowed_payment_method_types`);
- send it to the reader with `process_payment_intent`;
- get the result from the `terminal.reader.action_succeeded`/`action_failed` webhooks, or by retrieving the PaymentIntent;
- after a decline, reuse the same PaymentIntent for the next card;
- in test mode, `present_payment_method` stands in for the tap.

## Decision

- **A card payment is an attempt, not an order** (`card_payments`). The order is created only when Stripe says the payment succeeded, so a declined or abandoned card never reaches the order board or the cash drawer.
- **Prices come from the server's menu** (sold-out items refused), as for cash. The browser sends items and quantities only.
- **An idempotency key per attempt**, which Stripe also receives, so a double-tap can't start two payments.
- **Two ways to finish, one order.** The Stripe webhook is the main path. The register checks the status every 1.5 seconds, and if a payment is still waiting after 3 seconds, the server asks Stripe directly. That covers late or missing webhooks, which Stripe's own guidance asks for, and lets it work locally where webhooks can't arrive. A unique index on the order's PaymentIntent makes "create the order" happen exactly once, whichever path is first.
- **Declines:** the attempt is marked declined with Stripe's code (for example `generic_decline`). "Try another card" re-sends the same PaymentIntent; "Cancel card payment" stops the reader and cancels it. Declines, cancellations and test taps are audited.
- **"Simulate tap"** offers "approved card" or "declined card". The server picks Stripe's published test number (`4242…`/`4000…0002`) and sends it to Stripe's test helper. **The browser never sends or sees a card number**, and no card detail is ever stored: only Stripe's IDs and its decline code.
- **The board** shows each ticket's tender ("COUNTER · CARD").
- **The cash drawer** counts cash sales only, so card sales don't change the expected cash.
- **Card refunds** go back to the card through Stripe (PR 4.3). Until then a card sale **can't be refunded in cash**: the route and the refund screen both refuse it.
- **Session:** card-payment calls tighten the session to the register's 15-minute limit, like the other register calls.
- **Where it shows:** only where Stripe is set up, meaning a test key and a reader ID. Production has both (set up 2026-11-09). Previews and CI have neither, so the register says card payments aren't set up there.

## Consequences

- Production needs `migrations/0008_card_payments.sql` before this deploys.
- **Tests:**
  - `tests/api/staff-card.test.ts`, with a fake Terminal that behaves like the simulated reader:
    - routes and roles, and the not-set-up case;
    - approved by webhook, one order even when two events arrive;
    - approved with no webhook (the status check);
    - declined, then another card, then cancel;
    - a busy reader;
    - server pricing, strict bodies, a sold-out item, idempotency per person, a tap only while waiting;
    - no cash refund of a card sale, and no card sale in the cash drawer.
  - `tests/unit/terminal.test.ts`: how Stripe's states map to the register's.
  - Checked once against **Stripe's real test API** on 2026-11-09 with the local key and simulated reader:
    - an approved tap became order #1 through the status check;
    - a declined tap returned `generic_decline`;
    - cancel worked;
    - in a browser at 360 and 1024 pixels: decline, another card, approve, with no serious accessibility findings.
    - The throwaway test isn't committed, because CI has no Stripe key.

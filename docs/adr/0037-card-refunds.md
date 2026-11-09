# ADR-0037: Card refunds through Stripe

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

PR 4.2 (ADR-0036) blocked refunds of card sales, so a card sale could never be paid back in cash. The plan (§6.1, §6.2): Manager+ refunds through Stripe's Refunds API, with the same separation-of-duties rule as cash refunds (ADR-0034), confirmed by Stripe's webhooks.

## Decision

- **The same rules as cash** (ADR-0034):
  - Manager+ only;
  - **never the person who took the payment unless they're the Owner** (refusal audited, AC-5);
  - amounts from the sale's own lines;
  - a reason from the list;
  - review, then confirm;
  - one idempotency key per refund screen;
  - the database trigger that refuses refunding more than was sold.
- **The money goes back to the card**, never out of the cash drawer. The drawer counts cash refunds only, as before.
- **Order of operations:**
  1. The refund and its lines are recorded first, as **pending**, so the over-refund trigger holds while Stripe is asked.
  2. Then Stripe's Refunds API is called, with an idempotency key derived from the refund screen's key: a retry can't refund twice at Stripe either.
  3. Stripe's answer sets the status: **succeeded** or **pending**.
- **If Stripe refuses or later reports failure** (the `refund.failed` webhook, or `refund.updated` with failed or canceled):
  - the refund is marked **failed** and audited (`order.refund_failed`);
  - its lines are **released**, so the drinks can be refunded again;
  - a sale that had been marked fully refunded goes back to **paid**.
  - Failed refunds never count toward "refunded so far" anywhere: the refund screen, the list, or the order's payment state.
- **Webhooks:** `refund.updated` and `refund.failed` are matched to the site's refund by Stripe's refund ID, or by the site's own ID in the refund's metadata.
- **Where Stripe isn't set up** (previews, CI without a key), a card sale can't be refunded at all, and never in cash.
- Stripe groups charges and refunds into one permission, so the Worker key's refund permission also allows creating charges (ADR-0035).

## Consequences

- No migration: the `refunds` table already had `status` and `stripe_refund_id` (migration 0006).
- **Tests** (`tests/api/staff-card.test.ts`, fake Stripe):
  - the payment-taker refused, with the refusal audited, and another manager allowed;
  - pending, then succeeded by webhook;
  - Stripe refusing: nothing refunded, the line released, refundable again, audited;
  - a full refund later failing: back to paid, lines released;
  - one Stripe call per key;
  - no Stripe means no card refund, and never cash;
  - a card refund never touches the cash drawer.
- **Checked against Stripe's real test API** (2026-11-09, local key and the simulated reader): a $7.00 card sale; a $4.00 partial refund, succeeded; the remaining $3.00, succeeded; a further refund refused (409). That throwaway test isn't committed.
- **CR-002 acceptance test 2** ("a refund by the person who took the payment is refused and the refusal is in the audit log") can now be evidenced in production for card sales. Michael's check after merge provides it.

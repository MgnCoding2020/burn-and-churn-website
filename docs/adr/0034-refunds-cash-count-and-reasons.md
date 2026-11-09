# ADR-0034: Refunds, the end-of-shift cash count, and reason lists

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Phase 3's last part (plan §4.4, §6.3): refunds with separation of duties, and the end-of-shift cash count. Michael's decisions on 2026-11-09:

- reasons are chosen from **fixed lists**, not typed;
- a refund covers the **whole sale or chosen drinks**;
- the drawer is **opened with a float and counted per shift**.

## Decision

### Reason lists (`src/lib/reasons.ts`)

- One list each for overrides (sold out), restock rejections, refunds and cash differences. Each ends with **Other**, which needs a note (up to 200 characters).
- The server accepts only listed codes. The audit log stores the code and the readable text, so it can be counted ("how many overrides were mistakes?").
- Changing a list is a code change, reviewed in a PR.
- This replaces the free-text reasons of ADR-0033.

### Refunds (`POST /api/v1/staff/orders/:id/refunds`, `/staff/refunds/`, `/staff/refund/`)

- **Manager+ only**, and **never by the person who took the payment unless they're the Owner** (AC-5). A refused attempt is audited (`order.refund_refused`).
- The browser sends line numbers and quantities only. **Amounts come from the sale's own lines**, so a refund can't exceed what was paid.
- A database trigger refuses refunding any line beyond what was sold. It aborts the whole refund, so two managers refunding at once can't over-refund.
- An idempotency key per refund screen: a double-tap or retry refunds once. A key reused by someone else is refused.
- A fully refunded sale is marked `refunded` and leaves the order board.
- A review-then-confirm step shows the amount before anything is saved.
- **Cash only** until Stripe (Phase 4): the screen tells the manager how much cash to give back. The `refunds` table already has `status` and `stripe_refund_id` for card refunds.

### The cash drawer (`/api/v1/staff/cash/*`, `/staff/cash/`)

- **Open (Shift Lead+):** a float, $150 by default. One drawer open at a time (partial unique index).
- **Close (Shift Lead+):** a **blind count** by denomination.
  - The expected amount is shown only after the count is saved, and a saved count **can't be redone**, so nobody can recount until the numbers match.
  - Expected = float + cash sales − cash refunds while it was open.
- **Explain (the closer, or Manager+):** a difference over **$5** either way needs a reason from the list.
- **Review (Manager+, never the closer unless Owner):** any count with a difference is reviewed, after its reason if one is needed. A refused review is audited (`cash.review_refused`).
- **Visibility:** a Shift Lead sees the drawers they opened or closed; a Manager+ sees all drawers, because reviewing them is their job.
- **Cash sales taken with no drawer open** are counted and shown as a warning on the Cash screen. Sales aren't blocked, so the counter keeps working.
- Every step is a guarded update with its audit row in the same batch, written only if the update happened (`auditIfChanged`, ADR-0033).

### Retention

The hourly clean-up deletes refunds (with their sale) and cash counts after 90 days, like orders. The audit log keeps its record.

## Consequences

- Production and preview need `migrations/0006_refunds_cash.sql` before this deploys.
- Staff navigation adds **Cash** (Shift Lead+) and **Refunds** (Manager+).
- **Known gaps:**
  - The register doesn't require an open drawer; the warning covers it. Revisit if the Owner wants sales blocked.
  - A count can't be corrected after saving. A mistake is explained with a reason and seen in review, which is the intended control.
  - Card refunds arrive with Stripe Terminal in Phase 4.
- Tests:
  - `tests/unit/reasons.test.ts`;
  - `tests/api/staff-refunds.test.ts`: role refusals, own-sale refusal audited, the Owner exception, amounts from the sale, partial then full, over-refund refused, strict bodies and reasons, idempotency, concurrent refunds;
  - `tests/api/staff-cash.test.ts`: roles, one open drawer, exact count, refunds in expected, over-$5 needs a reason, own review refused and audited, small difference, bad bodies, sales outside drawers;
  - `tests/db/session.test.ts`: retention;
  - `tests/e2e/staff-refunds-cash.spec.ts`: navigation by role, a manager's partial refund with confirmation, own-sale refusal, open → blind count → explain, manager review, axe on each screen.

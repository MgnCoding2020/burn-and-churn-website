# ADR-0033: The restock chain

- **Status:** Accepted
- **Date:** 2026-11-08
- **Supersedes:** the sold-out and restock rules of [ADR-0032](0032-sold-out-restock-and-activity.md) (its activity-feed decisions stand)

## Context

Michael's role test of ADR-0032 (2026-11-08) found two gaps:

- one Manager could request a restock and close it alone;
- a Shift Lead could put a sold-out drink back on sale with one button, with no restock behind it.

He asked for a chain of command instead, so that no single person moves an item through every step. It's the same separation-of-duties principle as refunds (AC-5) and least privilege (AC-6).

## Decision

| Step                 | Who                                                    | Effect                                                    |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| 1. Mark sold out     | **Any staff role**                                     | The register greys the item out at once                   |
| 2. Request restock   | **Shift Lead+**, sold-out items only, one live request | Quantity and optional note                                |
| 3. Approve or reject | **Manager+**, never their own request unless Owner     | Approved = ordered. Rejecting needs a reason              |
| 4. Received          | **Shift Lead+**, approved requests only                | The item goes back on sale, in the same transaction       |
| Review               | **Manager+** (`/staff/restock-history/`)               | Every request with who requested, decided and received it |

- **Sold out persists** (Michael's choice): an item stays sold out until its restock is received. The per-day reset of ADR-0032 is gone (`sold_out_on` dropped in migration 0005; every item starts available).
- **Outside the chain**, an item comes back only by:
  - **undo**: the person who marked it, within 5 minutes (Michael's choice; a mis-tap shouldn't need a manager);
  - **override**: a Manager+ with a required reason, audited as `menu.item.override` with the reason.
  - A Shift Lead can do neither: their way back is a received restock.
- **Separation of duties:** deciding your own request is refused and the refusal is audited (`restock.decision_refused`). The Owner is the exception, as for refunds.
- **Concurrency:** every state change is a guarded update (`WHERE status = ...`). Its audit row is written only if the update changed a row (`auditIfChanged`, SQLite `changes()` in the same batch), so a lost race leaves no false audit entry. A partial unique index allows one live request per item.
- **Menu screen:** now open to every staff role. Each person sees only the controls their role allows, and the server enforces the same rules.

## Consequences

- Migration `0005_restock_chain.sql` must be applied to production and preview before this deploys. It rebuilds `restock_requests` (SQLite can't change a CHECK constraint): old done rows become received; old open rows are closed as rejected with a reason.
- A drink can stay sold out for days if no one requests a restock. That is intended: the Owner sees it in the history, and the Inventory list (Phase 7) will show stock levels.
- An approved request has no cancel step yet. If a delivery never comes, a Manager overrides the item and the request stays approved in the history. Revisit with Inventory in Phase 7.
- Tests (`tests/api/staff-menu.test.ts`, `tests/e2e/staff-menu.spec.ts`): route principals; undo only by the marker inside 5 minutes; persistence across days; override needs Manager+ and a reason; the full chain by role; self-approval refused and audited, allowed for the Owner; reject needs a reason; one live request per item; two managers approving at once leave one approval and one audit row; the history page refused below Manager.

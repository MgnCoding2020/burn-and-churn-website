# ADR-0032: Sold-out items, restock requests and staff activity

- **Status:** Accepted; the sold-out and restock rules are superseded by [ADR-0033](0033-restock-chain.md) (the activity feed stands)
- **Date:** 2026-11-08

## Context

Phase 3's second part (plan §4.4). Michael set the visibility rule on 2026-11-08:

- a Barista sees their own work;
- a Shift Lead also sees the Baristas';
- a Manager also sees the Shift Leads' changes, and raises restock orders for sold-out items;
- the Owner sees everything.

## Decision

- **86 an item (Shift Lead+):** `POST /api/v1/staff/menu/:itemId/availability` sets `item_availability.sold_out_on` to today's business day, or clears it. An item is sold out only while that date is today, so it **comes back by itself the next day**: no nightly job to forget or to fail. The register greys it out, and the sale route prices against today's menu, so a stale register page can't sell it either.
- **Restock requests (Manager+):** a free-text quantity and an optional note for a menu item; listed until marked done. Stock levels themselves come with the SharePoint Inventory list (Phase 7); this is the request, not inventory.
  - **Done means the stock arrived** (amended 2026-11-08 after Michael's role test): if the item is sold out today, marking the request done also puts it back on sale, in the same transaction, with its own `menu.item.available` audit row. The button reads "Done, back in stock" in that case. Before this, Done closed only the request and left the item sold out, which read as if Done had re-marked it sold out.
- **Every change is audited in the same transaction** (D1 batch):
  - the 86 change, with before and after;
  - restock requested and done;
  - **each sale**, as `order.sale` with its order number. The order number is read inside the database, so the audit row can't disagree with the order.
- **Activity (everyone):** `GET /api/v1/staff/activity` and `/staff/activity/` read the audit log:
  - **you see your own rows, plus rows whose `actor_role` is below yours**;
  - the Owner sees all rows, including those with no actor (refused sign-ins of real accounts).
  - The role compared is the one recorded at the time, so a later promotion doesn't hide or reveal history.
  - Pagination is by cursor (`before` = the last id); the page needs no script ("Older activity" is a link).
- **"Shifts"** are shown as sign-ins and sign-outs until the Shift Notes list (Phase 7).
- **Menu screen** (`/staff/menu/`, Shift Lead+): restock controls appear for Manager+ only; the server enforces the same rule.

## Consequences

- One extra D1 write per sale (its audit row), in the same batch.
- The audit log is now also the activity feed, so its wording matters. `describeEvent` maps each action to a sentence; unknown actions show their raw name rather than disappearing.
- Production needs `migrations/0004_availability_restock.sql` before this code deploys.
- Tests:
  - route principals, 86 refusals and audit, the stale-page sale refused, the next-day reset, restock lifecycle (Done puts a sold-out item back on sale), the visibility rule for each of the four roles, the sale's audit row, and pagination (`tests/api/staff-menu.test.ts`);
  - in a browser: a Barista refused the Menu screen, a Shift Lead's 86 shown on the register and in activity, and a Manager's restock request (`tests/e2e/staff-menu.spec.ts`).

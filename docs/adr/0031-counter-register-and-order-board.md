# ADR-0031: Counter register and order board

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

Phase 3 builds the staff portal's register (cash sales) and order board (plan §6.3, §13). Michael approved the wireframes and these choices on 2026-11-08: plain TypeScript rather than Preact, a board that polls every 5 seconds, and the end-of-shift cash count in this phase. Phase 3 ships in three pull requests; this record covers the first (register, board, sessions) and the decisions the other two build on.

## Decision

- **No front-end framework.** The register and board are server-rendered Astro pages with small typed scripts (`src/scripts/`). Preact islands inject inline scripts our CSP blocks (ADR-0013). Astro also inlines small _bundled_ scripts below Vite's `assetsInlineLimit`, which the CSP blocks too, so `astro.config.mjs` sets it to 0. Every script is an external file, and the browser tests watch for CSP violations on both pages.
- **Prices come from the server.** The browser sends only item, size, quantity and the cash handed over. The server prices the order from the same validated menu the public site uses (`seed/menu.json`, ADR-0014), and copies each line's name and price into the order. Until the SharePoint sync (Phase 7), the menu stays in that file rather than a D1 table, so it isn't built twice.
- **Cash sales** (`POST /api/v1/staff/orders`, Barista+): the cash handed over must cover the total; change is computed on the server; the order records who took the payment (`taken_by`, for the refund rule in PR 3). **An idempotency key** per sale means a double-tap or a retry records one sale. A key reused by someone else gets a conflict, not their sale.
- **Order numbers** restart each business day: the day's highest plus one, computed inside the insert, so two tablets can't get the same number.
- **Store time zone:** America/New_York, an **assumption** for a fictional café with no address (none is published, per §10.1). It only decides where "today" starts.
- **The board** (`GET /api/v1/staff/orders`) is polled every 5 seconds. Orders move one step at a time (New → In progress → Ready → Collected), and each move names the stage it expects, so two people tapping at once get a conflict instead of skipping a step.
- **Shared-tablet sessions** (plan §4.1, §4.3):
  - Using a register screen or its API tightens that session's idle limit to **15 minutes for good**. It never loosens back to an hour on the same session.
  - Polling the board doesn't count as activity, so a board left open still times out. The timeout warning (ADR-0028) works unchanged, and now also changes the tab title.
- **Staff touch targets** get their own token, `--bc-staff-target` (48px). The public site keeps 44px.
- **Retention:** the hourly clean-up deletes orders older than 90 days (plan §9).

## Consequences

- A tablet left on the board signs out after 15 minutes without a sale or a move. That's the intended shared-device control; the warning offers "Stay signed in".
- Polling costs one small D1 read every 5 seconds per open board, well inside the free daily read allowance.
- Production needs `migrations/0003_orders.sql` applied before this code deploys, since the new routes use its tables.
- Tests:
  - routes, authorization, CSRF, server pricing, idempotency, numbering, board moves and conflicts, and the session tightening (`tests/api/staff-orders.test.ts`);
  - pricing and the business day (`tests/unit/orders.test.ts`);
  - retention (`tests/db/session.test.ts`);
  - a full sale and the board in a real browser, with axe and a CSP check (`tests/e2e/staff-register.spec.ts`).

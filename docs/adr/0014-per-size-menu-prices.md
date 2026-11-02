# ADR-0014: Menu prices are per size, in integer cents

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The approved menu has 20 coffee drinks in five categories. Espresso is sold as one double shot ($3.00); every other drink comes in 12, 16 and 20 oz, each with its own price. The original plan gave the SharePoint **Menu** list and the D1 `menu_items` table a single price per item, which can't represent this. The counter register and online checkout both price by size.

## Decision

- Prices are **integer cents** everywhere: data, database, API and Stripe. Never floating-point dollars.
- An item has one or more **variants**, each with its own price and availability: `double-shot` for espresso; `12oz`, `16oz` and `20oz` for everything else. No other sizes are valid.
- The SharePoint list contract (`docs/contracts/sharepoint-lists.md`, Phase 7) and the D1 schema (Phase 2 migrations) carry per-variant prices. The exact shape (price columns per size, or a separate variants list) is decided when the contract is written.
- Demo data lives in `seed/menu.json` and is validated by a zod schema: unique IDs, known categories, valid variants, whole-cent prices, coffee-only categories.
- The server always re-prices an order from its own data; a price sent by the browser is never trusted.

## Consequences

- One data model serves the public menu, the register and checkout.
- Changing a price is a data change, never a code change.

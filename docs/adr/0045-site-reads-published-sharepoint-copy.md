# ADR-0045: The site shows SharePoint's published copy

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

ADR-0039 built the sync: every 15 minutes, and on a manager's **Publish**, the Worker reads the SharePoint lists through Graph, validates every row, and stores each list's last good copy in `sharepoint_snapshots`. Until now nothing read those copies. The menu, the register, the cart and checkout all used the built-in `seed/menu.json`, and the home page had fixed hours.

The trial's test T-SP-06 ("change a price in SharePoint, Publish, and the public menu and register show it") needs the site to read the copies. The Owner asked for everything that doesn't need the trial to be built before it starts (2026-11-14).

## Decision

- **One place decides what's shown.** `src/lib/published.ts`:
  - `publishedMenu(db)` returns the stored Menu copy.
  - `publishedHours(db)` returns the StoreHours copy, Monday first.
  - Until a list has ever synced (previews, local, before the trial), both return the **built-in copy**. It matches what `setup-sharepoint.ps1 -Seed` puts in the lists, so the first sync changes nothing visible.
  - A stored copy is checked for shape again when read. A malformed row can only mean "use the built-in copy", never a broken page.
- **Everything that sells uses it.** `currentMenu(db)` (today's sold-out marks on top) now starts from the published menu. So do:
  - the register;
  - the cart's `GET /api/v1/menu`;
  - checkout pricing;
  - sold-out marks and restocks, so a drink that exists only in SharePoint can be marked sold out;
  - the checkout's "sold out today" message.
- **Pages rendered per request:**
  - **`/menu/`** shows the published menu with today's sold-out marks.
  - **The home page** shows **Café Hours** from the StoreHours copy, with days that share hours grouped ("Open daily", or "Monday to Friday…"), and **Open now / Closed now** in the store's time zone. The featured drink's price is the published one.
  - Both pages were prerendered before. The built-in menu is still validated at build time.
- **The header's "Hours" link returns** (to `/#hours`). The contact page points there instead of repeating fixed hours, and the old `src/data/store-hours.ts` constant is removed.

### Announcements, shift notes and low stock (7.3)

- **Announcements** show from `StartsOn` to `EndsOn`, inclusive, in the store's time zone. **Public** ones appear on the home and menu pages (the pages rendered per request); **staff** ones appear on the portal home. The other public pages are prerendered and don't show them.
- **Shift notes:** a read-only **Notes** screen for every staff role, showing the last 14 days, newest first (contract §4).
- **Low stock:** supplies at or below their par level, with the menu names of the drinks they're used in. It's shown on the portal home and the staff Menu screen. **It's a warning only:** marking a drink sold out stays a person's decision, and counts are kept in SharePoint.
- **Before the first sync, or with a malformed copy,** these show nothing. There's no built-in copy, because there's nothing true to show.

## Consequences

- **A Publish shows up at once** on the menu, the home page, the register and the cart, with no deploy.
- **Performance:** the home and menu pages each read one or two small D1 rows per request instead of being static files. The mobile Lighthouse gate (95+) should be re-checked on the live site after the merge.
- **SharePoint content is still untrusted.** It's rendered as text by Astro, never with `set:html`, and validated twice: at sync (ADR-0039) and at read.
- **Verification:** `tests/api/published.test.ts` and `tests/unit/published-hours.test.ts` check:
  - the built-in fallback;
  - a published price reaching the cart, the register and checkout pricing;
  - a SharePoint-only drink marked sold out;
  - a malformed copy falling back;
  - hours grouping and "open now" across the time zone.

  The real test is T-SP-06 in the trial.

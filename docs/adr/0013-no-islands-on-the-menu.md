# ADR-0013: No Preact islands on the menu page

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The menu design calls for category browsing, shareable category links that work with Back and Forward, and a drink-detail dialog. The design hand-off suggested Preact components hydrated as Astro islands.

Astro adds inline scripts to the page to hydrate islands. The CSP (ADR-0004) allows only `script-src 'self'`, so those scripts would be blocked, and the existing "page loads without CSP violations" test would fail. Allowing them means either `unsafe-inline` (which defeats the CSP) or per-build script hashes in the header (more moving parts). The plan's budget is also under 100 KB of JavaScript on public pages.

## Decision

- Category navigation uses **plain anchor links** to `section` landmarks. Back, Forward and deep links work with no JavaScript.
- The drink detail uses the browser's native **`<dialog>`** element, opened by one small external script module bundled by Astro (allowed by `script-src 'self'`). Focus is trapped by the dialog and restored on close; Escape closes it.
- Preact (planned in ADR-0002's stack) is introduced later for the cart and the register, with its own record covering how its hydration scripts satisfy the CSP.

## Consequences

- The menu works fully without JavaScript, except the detail dialog, whose content is also visible in the page.
- Very little JavaScript on public pages.
- If a later feature needs islands on public pages, the CSP approach gets decided once, in its own record.

# ADR-0012: Public site uses one dark theme

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The plan asked for WCAG 2.2 AA in both light and dark themes. The approved brand direction ("Midnight Roastery": espresso-black backgrounds, cream serif headings, copper and burnt-orange accents, low-key photography) is built on darkness; a light version would be a second design, not a colour swap. WCAG doesn't require a light mode; it requires sufficient contrast in whatever is offered.

## Decision

- The public site ships **one dark theme**, with `color-scheme: dark`. Every text and control pair is contrast-checked against it.
- Contrast fixes made while approving the palette (ratios measured 2026-11-02):

| Problem                               | Ratio     | Fix                                                                | New ratio |
| ------------------------------------- | --------- | ------------------------------------------------------------------ | --------- |
| White text on the `#D65B25` button    | 3.90      | Button fill `#B34A1C`                                              | 5.37      |
| Lighter hover oranges with white text | 2.93–2.99 | Hover darkens to `#A13D17`                                         | 6.57      |
| `#D65B25` orange text on cards        | 4.26      | Orange text `#E2763F`                                              | 5.45      |
| `#62483B` borders on controls         | 2.31      | Control borders `#93705A` (decorative card borders keep `#62483B`) | 4.33      |

- The staff portal is decided separately. It will use the same palette family at higher contrast, with no imagery.

## Consequences

- Accessibility tests run in the dark colour scheme only.
- Users who need a light interface rely on browser or OS tools (forced colours, reader modes). The site must stay usable in Windows forced-colours mode; this is added to the Phase 1 test list.

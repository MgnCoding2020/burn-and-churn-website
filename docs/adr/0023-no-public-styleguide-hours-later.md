# ADR-0023: No public styleguide page; "Hours" leaves the header until Phase 7

- **Status:** Accepted
- **Date:** 2026-11-05

## Context

Reviewing Phase 1 live, the owner asked for the site to stay realistic: a real café's site doesn't publish its design styleguide, and the header's "Hours" link only jumped to a card on the homepage, which felt like going back home. The plan (§10) had listed a `/styleguide/` page, and Phase 7 brings a Store Hours list from SharePoint.

## Decision

- **`/styleguide/` removed** from the site (`src/pages/styleguide.astro` and its CSS deleted). The design record stays in the repository:
  - `docs/design/tokens.md`: every colour and contrast pair, generated and checked in CI as before;
  - `docs/design/styleguide-2026-11-05.png`: a full-page screenshot of the styleguide as it stood.
- **Header navigation is Home · Menu · Story.** "Hours" returns in Phase 7, with the Store Hours list. The Café Hours card stays on the homepage.

## Consequences

- One fewer public page to secure and test.
- Seeing components together now means reading the repository or running the site locally; a later design change would update the screenshot by hand.
- A test checks `/styleguide/` returns 404 and that the header has no Hours link, so neither comes back by accident.

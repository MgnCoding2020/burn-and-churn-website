# Lighthouse runs, 2026-11-03

Run by the project owner in Chrome DevTools against the live site (`https://burn-and-churn-website.naultmichael.workers.dev`), Lighthouse 13.5.0, Chromium 156. Screenshots in this folder.

| Run                    | Page     | Device  | Performance | Accessibility | Best Practices | SEO |
| ---------------------- | -------- | ------- | ----------- | ------------- | -------------- | --- |
| 1 (12:05 EST)          | `/`      | Desktop | 100         | 100           | 100            | 66  |
| 2                      | `/menu/` | Mobile  | **79**      | 100           | 100            | 66  |
| 3 (after PRs #14, #15) | `/`      | Mobile  | **87**      | 100           | 100            | 66  |
| 4 (after PRs #14, #15) | `/menu/` | Mobile  | **93**      | 100           | 100            | 66  |

## Reading the results

- **SEO 66 is the intended result.** Lighthouse reports "Page is blocked from indexing" from three sources: the `noindex` meta tag, the `X-Robots-Tag: noindex, nofollow` header and `robots.txt` (`Disallow: /`). That's the plan's rule that a fictional business must never appear in search results; the score is evidence the control works.
- **Mobile menu Performance 79 fails the plan's gate (95+).** Lighthouse flagged:
  - _LCP request discovery:_ the menu hero image (the largest element on phones) lacked `fetchpriority="high"`.
  - _Network dependency tree:_ HTML → CSS → Oswald font finished at about 1,006 ms.
  - _Render-blocking requests:_ two CSS files, 7.3 KB in total. Not changed: inlining CSS would need `unsafe-inline` or hashes in the CSP.

## What was changed

PR "Menu: LCP image gets fetchpriority=high" adds `fetchpriority="high"` to the menu hero image. Local throttled measurements (slow-4G approximation, 4× CPU) showed that **adding** preloads for the image and the Oswald font made things worse on slow links (they competed with the CSS), so none were added. The local measurements varied by about ±0.7 s between runs, so the result must be confirmed with Lighthouse itself.

## Still to record

- [x] Mobile Lighthouse on `/menu/` and `/` after the fix: menu 79 → **93**, home **87**. Both still below the 95 gate.
- [x] Home (mobile): the cause was image work, not JavaScript (TBT ≈ 930 ms). Fixed by right-sizing images and serving WebP instead of AVIF; local Lighthouse 13.6.0 TBT fell to about 110–140 ms (ADR-0019).
- [ ] Re-run both after the next fixes (gate: Performance ≥ 95)

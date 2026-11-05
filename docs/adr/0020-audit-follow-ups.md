# ADR-0020: Follow-ups from the 2026-11-04 code audit

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

A full-repository audit (run by Claude with access to the repo, at the owner's request) praised the structure and listed five non-urgent items. Each was checked against the code and the live site before acting:

| #   | Finding                                                           | Checked                                                                                                                                |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Preview deployments run with `APP_ENV=production`                 | True: `wrangler.jsonc` set one `vars` block for every deploy                                                                           |
| 2   | Push protection enabled but never exercised                       | True: recorded as such in the threat model (owner's choice, 2026-11-02)                                                                |
| 3   | Fonts, images, video and page scripts re-requested on every visit | True: live responses carried `Cache-Control: public, max-age=0, must-revalidate`; only `/_astro/` (hashed names) was cached for a year |
| 4   | `hero-video.js`: a refused `video.play()` goes unhandled          | True: the promise had no `.catch`                                                                                                      |
| 5   | `wrangler types` warns that `@types/node` isn't installed         | True, but generic: no compatibility flags are set and `src/` imports nothing from `node:`                                              |

## Decision

1. **Preview-only settings:** `wrangler.jsonc` gains a `previews` block (supported by Wrangler 4.153, used by `wrangler preview`) with `APP_ENV=preview`. Phase 2's preview-only secrets and database go in the same block. `GET /api/v1/health` now reports `environment`, which is not secret and lets anyone confirm a preview isn't production.
2. **Push protection:** unchanged. Exercising it stays optional for the owner; the threat model keeps saying "configured, not exercised" until it is.
3. **Cache policy** (`src/lib/cache-policy.ts`, applied in the response pipeline to successful responses only):

   | Path                                     | Cache-Control                                                   | Why                                                  |
   | ---------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
   | `/fonts/`                                | `public, max-age=2592000` (30 days)                             | Font files never change in place                     |
   | `/images/`, `/media/`                    | `public, max-age=604800, stale-while-revalidate=86400` (7 days) | Rarely change; names aren't versioned                |
   | `/scripts/`                              | `public, max-age=3600` (1 hour)                                 | They carry behaviour, so updates must arrive quickly |
   | Pages, API, `robots.txt`, `security.txt` | unchanged (revalidated)                                         | Deploys show up immediately                          |

   Replacing an image under the same file name can now take up to a week to reach returning visitors; give replacements a new name or accept the delay.

4. **`video.play().catch(sync)`:** if the browser refuses to play, the button label goes back to the true state instead of an unhandled rejection.
5. **`@types/node` not installed:** the Worker code never uses Node APIs, and the two Node-side scripts are plain `.mjs` outside the type check. Installing the types would only silence the warning and add a dependency. Revisit if Worker code ever needs `nodejs_compat`.

## Consequences

- Returning visitors download about 650 KB less (images, fonts, video) on repeat visits.
- Tests cover the cache policy (unit and against the built Worker) and the health response's `environment`.

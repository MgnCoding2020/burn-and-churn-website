# ADR-0022: Branded 500 page and a maintenance switch

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

Two gaps remained in Phase 1:

1. An unexpected error on a **page** returned the API's JSON problem response, which is right for API callers and wrong for people.
2. The incident plan (plan §9, IR-4) needs a way to "take the site to a maintenance page" quickly, without a code change, and without a later deploy undoing it mid-incident.

## Decision

- **500 page:** `src/pages/500.astro` is prerendered. When a non-API request throws, the pipeline's error handler serves it from the asset store with status 500 and `Cache-Control: no-store`. API requests keep the RFC 9457 problem response. Neither includes internal details.
- **Maintenance mode:** a Worker setting `MAINTENANCE_MODE` (`on`, `off` or unset). When `on`, a pipeline step after the test-mode guard returns:
  - pages: the prerendered `/maintenance/` page, **503**, `Retry-After: 600`, `no-store`;
  - API: a 503 problem response with `Retry-After`;
  - and still serves `/_astro/`, `/fonts/`, `/images/`, `robots.txt`, `/.well-known/` and the health check, which reports `"maintenance": true`.
- It's set as a **secret**, not a `vars` entry: deploys replace `vars` from `wrangler.jsonc`, but leave secrets alone, so merging during an incident can't switch maintenance off.
- Any other value fails the environment check, so the site stops rather than guessing.
- How to use it: `docs/runbooks/maintenance-mode.md`.

## Consequences

- Verified on the local Cloudflare runtime (`wrangler dev --var MAINTENANCE_MODE:on`, 2026-11-04): pages and API 503 with `Retry-After`; health 200 with `maintenance: true`; the page's CSS and fonts served.
- Security headers, the request ID and logging apply to these responses like any other.
- `/500` and `/maintenance/` can also be visited directly; both are `noindex` like every page.

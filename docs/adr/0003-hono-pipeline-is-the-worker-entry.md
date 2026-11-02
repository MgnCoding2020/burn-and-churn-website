# ADR-0003: Our Hono pipeline is the Worker entry, ahead of static assets

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Every response, including HTML pages, CSS files and `robots.txt`, must carry the security headers, a request ID and `noindex`, and must be refused if the Worker is misconfigured (ADR-0004, ADR-0006).

Testing on Cloudflare's local runtime showed two ways static files bypassed our code:

1. **Cloudflare serves static assets before the Worker** unless told otherwise.
2. **The adapter's default entry point** (`@astrojs/cloudflare/entrypoints/server`) also serves any matching static file before calling Astro, and Astro only then calls our `src/fetch.ts`.

The result: pages and CSS were served with none of our headers, while API responses had them all.

## Decision

- `wrangler.jsonc` sets `"main": "./src/fetch.ts"`, so our Hono app receives every request first. Astro 7 supports this (its `fetchFile`), and the adapter lazy-loads its internals specifically so a custom entry can import it.
- `assets.run_worker_first: true`, so Cloudflare sends every request, static files included, to the Worker.
- The pipeline order is: request ID → security headers → request log → HTTPS redirect → test-mode guard → `/api/v1` → Cloudflare static assets (`cf()`) → Astro pages.
- Responses from the asset store have immutable headers, so the header layer re-wraps the response before setting them.
- At build time Astro prerenders pages through the same pipeline **with no Worker env and no execution context**. The test-mode guard and `cf()` skip when `c.env` is undefined; a deployed Worker always has an env, so this is the build, not a bypass.

## Consequences

- One place applies every response-level control, tested end to end (`tests/e2e/headers.spec.ts` checks pages, CSS, `robots.txt`, the 404 page and API responses).
- Every request, static files included, counts against the Worker's request quota.
- The setup depends on adapter internals (`@astrojs/cloudflare/hono`). Adapter upgrades must re-run the headers e2e test, which CI does on every PR.

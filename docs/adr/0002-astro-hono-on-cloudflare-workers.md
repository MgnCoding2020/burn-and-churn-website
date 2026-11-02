# ADR-0002: Astro and Hono on Cloudflare Workers

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The site has three parts: a fast public site, a signed-in staff portal and register, and a JSON API that handles sign-in, Stripe webhooks and SharePoint sync. It must cost nothing to host, support a preview per branch, and keep a small, reviewable codebase.

## Decision

| Concern    | Choice                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting    | Cloudflare Workers (free tier), one Worker serving pages, API and static files                                                                                                |
| Pages      | Astro 7 with TypeScript and the `@astrojs/cloudflare` adapter. Pages are prerendered by default (`prerender = true`); on-demand rendering only where data changes per request |
| API        | Hono at `/api/v1`, mounted in the same Worker                                                                                                                                 |
| Validation | zod, shared by the API and the front end                                                                                                                                      |
| Tests      | Vitest for units and the API (run in Node against the Hono app), Playwright against the **built** Worker running on Cloudflare's local runtime (`wrangler dev`)               |

`astro.config.mjs` uses `output: 'server'`. With all-static output Astro built no Worker at all, because the API lives in `src/fetch.ts` (ADR-0003), which Astro does not count as a route; the API then disappeared from the build. Pages opt back into prerendering one by one.

## Consequences

- One deploy, one origin: no CORS, one security-header layer, one set of logs.
- Free tier limits apply (100,000 requests a day). Enough for a portfolio project; noted in the threat model as an availability limit.
- Tests use `wrangler dev`, not `astro preview`. `astro preview` is Vite's preview server: it serves static files itself and adds CORS headers, so it doesn't behave like Cloudflare (found 2026-11-02).

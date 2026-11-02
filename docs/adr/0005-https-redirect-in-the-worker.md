# ADR-0005: HTTPS redirect in the Worker

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Checking the first production deploy showed `http://burn-and-churn-website.naultmichael.workers.dev/` served the page with a 200. The plan requires HTTPS only (SC-8).

- Cloudflare's "Always Use HTTPS" is a setting on a custom domain's zone; it doesn't apply to a `workers.dev` address.
- Browsers ignore a `Strict-Transport-Security` header received over plain HTTP, so HSTS can't protect the first visit.

## Decision

The pipeline answers any `http:` request to a non-loopback host with a **308** to the same URL on `https:` (path and query kept; 308 keeps the method). The redirect still carries the security headers and a request ID. `localhost`, `127.0.0.1` and `[::1]` are exempt so local development, the build's prerender step and the browser tests work over HTTP.

## Consequences

- Verified live on 2026-11-02: `http://` → `308` → `https://` (PR #3).
- If the site moves to a custom domain, turn on "Always Use HTTPS" in the zone as well; the Worker redirect stays as a second layer.

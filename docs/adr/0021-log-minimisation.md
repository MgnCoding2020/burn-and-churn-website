# ADR-0021: Minimise what request logs contain

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

Writing the privacy page meant stating exactly what the site logs. Two sources:

1. **Our own log line** per request (`src/server/app.ts`): method, path, status, timing and the request ID. No query strings, cookies or bodies, by design.
2. **Cloudflare's invocation logs** (Workers Logs, enabled with `observability.enabled`): Cloudflare records each request and response with its own metadata, which can include connection details. Cloudflare's documentation (checked 2026-11-04) gives retention as **3 days on the Workers Free plan** and 7 days on paid plans.

The invocation logs include the full request URL by default. From Phase 2, sign-in callbacks carry one-time authorisation codes and `state` values in the query string; those must never be written to logs (plan §9: no tokens in logs).

## Decision

- `observability.redact_query_string: true` in `wrangler.jsonc` (supported by Wrangler 4.153): query strings are removed from request URLs in logs and traces. Invocation logs stay on, because status codes and timings are useful when diagnosing problems.
- The privacy page states both log sources, what they contain and the 3-day retention, with the date it was checked.

## Consequences

- Debugging a request that depends on its query string means reproducing it rather than reading the logs. Accepted.
- If the Workers plan changes, update the retention on the privacy page and here.
- Phase 2 still avoids putting secrets in URLs at all; this setting is the second layer.

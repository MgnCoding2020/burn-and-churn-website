# ADR-0007: API conventions: deny by default, problem details, Origin check

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The API will handle staff roles, refunds with separation of duties, customer data and Stripe webhooks. The conventions need to make the safe path the only path before any of that exists (AC-3, AC-6, SC-23, SI-10).

## Decision

- **Every route declares its principal.** Routes are added only through `define({ method, path, principal }, handler)`; the principal is `public`, `customer`, or a minimum staff role (`Staff.Barista` < `Staff.ShiftLead` < `Staff.Manager` < `Staff.Owner`). A test fails if any registered route lacks one.
- **Deny by default:** unknown routes return a 404 problem; protected routes return 401 (signed out) or 403 (wrong directory or role). Staff and customer sessions can't be confused: staff routes need a workforce sign-in **and** a role.
- **Errors use RFC 9457 problem details** (`application/problem+json`: `type`, `title`, `status`, optional `detail`, `requestId`). Never stack traces or upstream messages; the log records only the error's class.
- **CSRF:** `POST`, `PUT`, `PATCH` and `DELETE` need an `Origin` header equal to the site's own origin. Exemptions (Stripe webhooks, Phase 4/5) are listed explicitly and verified by signature instead.
- **No CORS**, a **16 KB** body limit, `Cache-Control: no-store` on every API response.
- **Request ID** generated per request, never accepted from the client, returned in `X-Request-Id` and in every problem body.

## Consequences

- The authorization ladder is fully unit-tested now (every role against every minimum role); Phase 2 only adds the session lookup.
- Every new route ships with an authorization test in the same PR (plan §16).
- The same-origin check uses the request's own origin, so preview URLs work without a configured allow-list.

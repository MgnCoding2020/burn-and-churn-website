# ADR-0006: Test-mode guard: refuse to serve with a live Stripe key

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The project's first rule is no real money and no real card data, ever. A live Stripe key in any environment would break that rule silently: payments would simply start working for real.

## Decision

One rule set (`src/lib/env.ts`), used in two places:

1. **The Worker**, on every request: if `APP_ENV` is invalid, if a Stripe key variable holds anything other than an `sk_test_` or `rk_test_` key, or if **any** variable holds a value that looks like a live Stripe key (`sk_live_`, `rk_live_`, `pk_live_`), every path returns `503` with a problem response. The log names the variable, never its value.
2. **`npm run check-env`**, before running locally and in CI (`--ci` checks the committed example files).

The rule file has no imports, so Node loads it directly from the script and the Worker bundles the same code.

## Consequences

- Verified on Cloudflare's local runtime with a fake live-format key: pages, API and static files all returned 503; the log named `STRIPE_API_KEY` only.
- Tests fail if the guard is removed (checked by disabling it: the guard tests failed as expected).
- Phase 4 extends the guard to refuse a Terminal reader that isn't a simulated one.
- A Worker without a Stripe key passes, so the site runs before Stripe is configured.

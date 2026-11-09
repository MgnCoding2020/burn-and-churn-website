# ADR-0035: Stripe library, keys and webhooks

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Phase 4 (plan §6.2) adds card payments at the counter through Stripe Terminal's simulated reader; Phase 5 adds online Checkout. Both need a way to call Stripe, a key, a one-time set-up (a Terminal location, a simulated reader, a webhook endpoint) and a webhook receiver.

Michael's decisions on 2026-11-09:

- use Stripe's official library;
- do the set-up with a script and its own short-lived key;
- assess Stripe as a vendor (VRA V-013) before Phase 4 goes live;
- build the site's own rate limiter as the first PR of Phase 5 (Cloudflare's still doesn't enforce, workers-sdk #16097, checked 2026-11-09).

## Decision

### Library

- **`stripe` 23.1.0**, pinned exactly (released 2026-10-29, at least 7 days old). It has no dependencies of its own.
- On Workers the package's own Worker build is used: fetch and Web Crypto, no Node polyfills.
- It runs server-side only, so it doesn't count toward the public pages' JavaScript budget.
- **API version pinned** to `2026-10-28.endive` (`STRIPE_API_VERSION`). Stripe's API changes reach the site only through a library upgrade we review.

### Keys

| Key                                                                                                     | Where                                                                              | Permissions                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker key** `bc-website-worker-test` (`rk_test_`), created 2026-11-09                                | `.dev.vars` locally; production Worker secret `STRIPE_API_KEY` when Phase 4 merges | Custom: PaymentIntents Write; Terminal Readers Write; Terminal Locations Read; Charges and Refunds Write; Checkout Sessions Write. Everything else None |
| **Set-up key** (`rk_test_`), made for one run of `scripts/stripe/setup-test.mjs` and deleted afterwards | Typed at the script's hidden prompt only                                           | Terminal Locations Write; Terminal Readers Write; Webhook Endpoints Write                                                                               |

- Stripe groups **charges and refunds** into one resource, so the Worker key's refund permission also allows creating charges. The site never creates charges. It's the narrowest option Stripe offers, and it's accepted here.
- The full `sk_test_` key isn't used by anything. The one pasted into a chat on 2026-11-09 was expired the same day.
- **Test mode is enforced in code three times:**
  - the Worker's environment check (ADR-0006);
  - `stripeConfig`, which accepts only `rk_test_`/`sk_test_`;
  - the set-up script.
- The set-up script also refuses a reader that isn't simulated.

### Webhooks (`POST /api/v1/webhooks/stripe`)

- **Public, but authenticated by signature.** Stripe's HMAC over the raw body is checked with Stripe's own verifier, with a **5-minute timestamp tolerance** against a captured request being replayed later.
- **Live-mode events are refused**, even if correctly signed.
- **Each event is recorded once** (`stripe_events`, primary key = event ID). A replay, or Stripe's own retry, is acknowledged with 200 and changes nothing. Only the ID, type and outcome are kept, never the payload; they're deleted after 90 days.
- **No database write before the signature checks out** (ADR-0030's rule). Refusals are logged with the reason only, never the body, header or secret.
- **Exempt from the browser Origin check** (Stripe sends none). That's the only exemption, and it's tested.
- Body limit **256 KB** on this path only; 16 KB everywhere else.
- **One endpoint, for production only**, created by the set-up script with the events counter payments and refunds need. Its signing secret is piped from the script straight into `wrangler secret put STRIPE_WEBHOOK_SECRET`, never displayed. Locally, the Stripe CLI's `stripe listen` forwards events with its own secret. Previews have no Stripe, as they have no sign-in secrets.
- Event handlers arrive with the features that need them (PR 4.2: counter card payments; PR 4.3: card refunds). Until then, events are recorded as `ignored`.

## Consequences

- Production needs `migrations/0007_stripe_events.sql` before this deploys.
- Michael's steps are in `docs/runbooks/stripe-setup.md`: run the script once, set the Worker secrets, delete the set-up key.
- The Terminal location has a **fictional address** (required by Stripe). It's visible only in the Stripe Dashboard, never on the site.
- **Tests** (`tests/api/webhooks-stripe.test.ts`):
  - the route is public, with no Origin needed;
  - a signed event is recorded once and a replay ignored;
  - a missing signature, the wrong secret and a changed body are refused with nothing written;
  - an expired timestamp and a live-mode event are refused;
  - a missing secret gives 503;
  - other routes still need the Origin;
  - `stripeConfig` accepts test keys only.
- Test values are built at runtime so no key-shaped string sits in the repository.

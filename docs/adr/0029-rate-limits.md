# ADR-0029: Rate limits with Cloudflare's Rate Limiting binding

- **Status:** Accepted; supplemented by [ADR-0040](0040-strict-rate-limits-durable-object.md) (2026-11-11)
- **Date:** 2026-11-07

## Context

The threat model accepted "no rate limiting on `/api`" in Phase 0, until the first state-changing route. Phase 2 brought those routes and the acceptance expired unnoticed; the repository audit of 2026-11-07 reopened it. The sharpest case: `GET /api/v1/auth/staff/login` is public and writes a row to D1 on every call, so a script could use up the Workers Free plan's 100,000 D1 row writes a day ([Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/), checked 2026-11-07) and stop staff sign-in until midnight UTC. Plan §9 asks for rate limits per IP and per session on `/api`.

Options considered (Michael chose the first, 2026-11-07):

1. **Cloudflare's Rate Limiting binding** (`ratelimits` in `wrangler.jsonc`). No package, no extra service; works for every later route.
2. Keep the PKCE verifier and nonce in an encrypted cookie, so sign-in start writes nothing. Removes this one risk, but needs a new secret and still leaves later routes unlimited.
3. Accept again until Phase 3. The same deferral that slipped once.

## Decision

- Two limiters, keyed on the client IP address from `CF-Connecting-IP` (set by Cloudflare; never `X-Forwarded-For`, which a client can write):
  - `API_LIMITER`: **120 requests a minute** per address on all of `/api/v1`.
  - `SIGNIN_LIMITER`: **20 a minute** per address on starting and finishing a staff sign-in, the only public routes that write to D1.
- Over the limit: `429 Too many requests` as a problem response, with `Retry-After: 60`. Pages and static files aren't counted.
- Production and previews use separate namespaces (`1001`/`1002` and `1101`/`1102`), so preview testing never counts against production.
- **If the binding is absent, requests pass**, and a deployed Worker logs `{"rateLimit": "<name>", "missing": true}` once per instance, so the gap shows in Workers Logs instead of failing silently. The limit is defence in depth; the site doesn't stop working without it. Unit tests run without it and inject a stand-in.

## What Cloudflare's documentation says, and doesn't (checked 2026-11-07)

From [the binding's page](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/):

- Periods can only be 10 or 60 seconds.
- Counts are kept per Cloudflare location and are eventually consistent, so requests can exceed the limit. A strict global limit would need Durable Objects.
- Cloudflare advises against keying on IP addresses because many users can share one. Before sign-in there's no other key, so the limits are set well above normal use (a shift change on one café network is far below 20 sign-ins a minute).

Neither that page nor [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) states whether the binding is on the Free plan. **This is proven by deploying, not assumed.** If Cloudflare doesn't provide the binding in production, this ADR is superseded and option 2 is used.

## Verification so far (2026-11-07)

| Where                                        | Test                                                     | Result                                                                                       |
| -------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Local runtime (`wrangler dev`, built Worker) | 140 requests to `/api/v1/health`                         | Wrangler lists both limiters; **120 answered 200, the next 20 answered 429**: the code works |
| Preview deploy (`feat-rate-limits`)          | 31 sign-in starts, then 140 health requests              | **No 429**: the preview build deployed, but the limiters didn't take effect there            |
| Preview, newest deploy                       | Cloudflare dashboard (Michael)                           | **Both limiters listed as attached bindings**                                                |
| Preview, newest deploy                       | 300 parallel health requests, 60 parallel sign-in starts | **No 429**                                                                                   |
| Production (after merge, PR #31)             | 150 parallel health requests                             | **No 429**: same as the preview                                                              |

**Cause: a known Cloudflare bug, not this code.** [workers-sdk issue #16097](https://github.com/cloudflare/workers-sdk/issues/16097) (opened 2026-10-06, open on 2026-11-07, labelled as needing Cloudflare platform support on 2026-11-04) reports the same thing on workers.dev with Workers Free accounts: the binding returns `success: true` far past its limit, while `wrangler dev` enforces correctly. So on this account the limiters are attached but don't limit, today. Until production shows 429s, the security page doesn't claim rate limits.

## Consequences

- The sign-in quota attack needs many addresses in many locations, not one script.
- A visitor's IP address is now used, briefly, for counting; the privacy page says so.
- Per-session limits for signed-in staff come with the register (Phase 3), when there's something worth limiting per person.

## Update, 2026-11-11

Cloudflare moved the bug report to [cloudflare/developer-platform#123](https://github.com/cloudflare/developer-platform/issues/123); it was still open. The routes that cost something now also have strict limits in a Durable Object (ADR-0040); this binding stays on all of `/api/v1`.

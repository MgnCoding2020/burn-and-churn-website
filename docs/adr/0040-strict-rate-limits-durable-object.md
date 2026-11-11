# ADR-0040: Strict rate limits in a Durable Object

- **Status:** Accepted
- **Date:** 2026-11-11

## Context

ADR-0029 attached Cloudflare's Rate Limiting binding to all of `/api/v1`. It enforces in `wrangler dev` but not on this workers.dev Free account: the binding answers "allowed" far past its limit. Cloudflare's bug report, first filed as workers-sdk #16097, now lives at [cloudflare/developer-platform#123](https://github.com/cloudflare/developer-platform/issues/123) and was still open on 2026-11-11. The threat model accepted "card routes called in a loop" until the first PR of Phase 5 (ADR-0035). Phase 5 adds more routes that cost something (customer sign-in, Stripe Checkout), and Phase 8 adds the AI helper, so the site needs a limiter that works now.

## Decision

- **A Durable Object counts**, one object per scope and caller (`idFromName("<scope>:<caller>")`). Each object handles one request at a time, so the count is exact and global, not per Cloudflare location.
- **Fixed window, in memory.** The object keeps a window start and a count; nothing is written to its storage. If Cloudflare evicts an idle object, its count starts again, which can only happen after the caller has stopped calling. The Free plan requires the SQLite storage class, so it's declared as one (`new_sqlite_classes`), but its storage stays empty. A fixed window can allow up to twice the limit across a window boundary; that's acceptable for these limits.
- **Only routes that cost something** (each check is a Durable Object request, 100,000 a day on Free, [checked 2026-11-11](https://developers.cloudflare.com/durable-objects/platform/pricing/)):

  | Scope      | Limit       | Caller                        | Routes                                                                      |
  | ---------- | ----------- | ----------------------------- | --------------------------------------------------------------------------- |
  | `signin`   | 20 a minute | IP address (no one signed in) | staff sign-in start and callback                                            |
  | `payments` | 30 a minute | the signed-in person          | card payment start, simulated tap, retry, cancel; refunds (all call Stripe) |
  | `publish`  | 4 a minute  | the signed-in person          | Publish from SharePoint (reads five lists through Graph)                    |

  Phase 5's customer sign-in and Checkout, and Phase 8's assistant, add their own scopes.

- **Declared with the route.** `define()` takes an optional `limit` next to the principal, and the limit runs **after** authorization, so a refused request never counts and the caller is the person, not their shared café IP. A test lists exactly which routes are limited.
- **Over the limit:** `429` problem response with `Retry-After` (seconds left in the window), and a log line with the request ID.
- **Fails open.** Without the binding, or if the object can't be reached, the request passes and a warning is logged, like ADR-0029: the limit is defence in depth, never a reason to stop the counter.
- **The binding limiter stays** on all of `/api/v1`: free, and it starts working when Cloudflare fixes the bug.
- **Previews** declare the binding again in the `previews` block, as Cloudflare requires (each preview gets its own objects; without it a preview fails with error 1101, [checked 2026-11-11](https://developers.cloudflare.com/workers/previews/resources/index.md)). The class is exported from `src/fetch.ts`; a test build confirmed the Astro adapter keeps the export.

## Verification

| Where                                                                                | Test                                                                                                                                                                             | Result                                                                                |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Unit and API tests                                                                   | Window arithmetic; Publish refused on the 5th call a minute per person; Barista refused before counting; sign-in counted per IP; missing or failing object lets requests through | `tests/api/strict-limit.test.ts`, 6 passing                                           |
| Built Worker, `wrangler dev`, binding removed so only this limiter acts (2026-11-11) | 23 sign-in starts from one address, then one from another                                                                                                                        | **20 × 302, then 429** with `Retry-After: 55`; the other address 302; refusals logged |
| Preview and production                                                               | Michael, after merge: 25 sign-in starts                                                                                                                                          | To be recorded                                                                        |

## Consequences

- Staff sign-in, Stripe calls and Graph reads are limited on this account today, not when Cloudflare fixes its binding.
- The Durable Object request quota is spent only on these routes (a few hundred a day at most here).
- Phase 5 and Phase 8 add a scope and a line in the route definition.

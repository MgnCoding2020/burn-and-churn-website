# Architecture decision records

Each record captures one significant decision: the context, what was decided, and what it costs. Records are never rewritten; a changed decision gets a new record that supersedes the old one.

**Statuses:** Proposed · Accepted · Superseded by ADR-NNNN.

| ADR                                                | Decision                                                        | Status   | Date       |
| -------------------------------------------------- | --------------------------------------------------------------- | -------- | ---------- |
| [0001](0001-record-architecture-decisions.md)      | Record architecture decisions                                   | Accepted | 2026-11-02 |
| [0002](0002-astro-hono-on-cloudflare-workers.md)   | Astro and Hono on Cloudflare Workers                            | Accepted | 2026-11-02 |
| [0003](0003-hono-pipeline-is-the-worker-entry.md)  | Our Hono pipeline is the Worker entry, ahead of static assets   | Accepted | 2026-11-02 |
| [0004](0004-security-headers-and-strict-csp.md)    | Security headers and a strict CSP on every response             | Accepted | 2026-11-02 |
| [0005](0005-https-redirect-in-the-worker.md)       | HTTPS redirect in the Worker                                    | Accepted | 2026-11-02 |
| [0006](0006-test-mode-guard.md)                    | Test-mode guard: refuse to serve with a live Stripe key         | Accepted | 2026-11-02 |
| [0007](0007-api-conventions.md)                    | API conventions: deny by default, problem details, Origin check | Accepted | 2026-11-02 |
| [0008](0008-dependency-policy.md)                  | Dependency policy: exact pins, a week's age, approval first     | Accepted | 2026-11-02 |
| [0009](0009-ci-and-branch-protection.md)           | CI gates, SHA-pinned actions, required checks on `main`         | Accepted | 2026-11-02 |
| [0010](0010-deploys-with-workers-builds.md)        | Deploys with Cloudflare Workers Builds                          | Accepted | 2026-11-02 |
| [0011](0011-astro-sessions-off-and-d1-deferred.md) | Astro sessions off; D1 binding deferred to Phase 2              | Accepted | 2026-11-02 |
| [0012](0012-dark-only-public-theme.md)             | Public site uses one dark theme                                 | Accepted | 2026-11-02 |
| [0013](0013-no-islands-on-the-menu.md)             | No Preact islands on the menu page                              | Accepted | 2026-11-02 |
| [0014](0014-per-size-menu-prices.md)               | Menu prices are per size, in integer cents                      | Accepted | 2026-11-02 |
| [0015](0015-hold-typescript-7-and-vitest-5.md)     | Hold TypeScript 7 and Vitest 5 until the tooling supports them  | Accepted | 2026-11-02 |
| [0016](0016-minimatch-security-override.md)        | Override minimatch to a fixed version                           | Accepted | 2026-11-02 |
| [0017](0017-hero-video-delivery.md)                | Hero video: poster first, desktop only, pausable                | Accepted | 2026-11-02 |
| [0018](0018-hero-loop-fades-in.md)                 | The hero loop fades in, and does not show without JavaScript    | Accepted | 2026-11-03 |
| [0019](0019-webp-and-right-sized-images.md)        | Serve right-sized WebP, not AVIF                                | Accepted | 2026-11-03 |
| [0020](0020-audit-follow-ups.md)                   | Follow-ups from the 2026-11-04 code audit                       | Accepted | 2026-11-04 |
| [0021](0021-log-minimisation.md)                   | Minimise what request logs contain                              | Accepted | 2026-11-04 |

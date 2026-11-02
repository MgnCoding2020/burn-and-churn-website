# ADR-0015: Hold TypeScript 7 and Vitest 5 until the tooling supports them

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Dependabot's first run (2026-11-02) proposed the two major upgrades ADR-0008 had already ruled out:

| PR  | Upgrade                  | CI result                                                  |
| --- | ------------------------ | ---------------------------------------------------------- |
| #6  | TypeScript 6.0.3 → 7.0.2 | Failed: type check, browser tests and the Cloudflare build |
| #5  | Vitest 4.1.12 → 5.0.5    | Passed                                                     |

Vitest 5 passed only because nothing in the project needs `@cloudflare/vitest-pool-workers` yet. Its latest release (0.23.0, 2026-10-07) still requires `vitest ^4.1.0` (checked 2026-11-02), and Phase 2 needs it to test against D1.

## Decision

- Both PRs closed with the reasons above.
- `.github/dependabot.yml` ignores **major** updates of `typescript` and `vitest`. Minor and patch updates still arrive.
- Revisit when `typescript-eslint` and `@astrojs/check` support TypeScript 7, and when the Workers pool supports Vitest 5. At that point the ignore rule is removed in the same PR as the upgrade.

## Consequences

- No upgrade-then-downgrade churn in Phase 2.
- Someone has to remember to revisit. The Phase 2 start checks the pool's Vitest support, and the weekly Dependabot run keeps minor versions current meanwhile.

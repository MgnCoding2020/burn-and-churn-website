# ADR-0008: Dependency policy: exact pins, a week's age, approval first

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Every dependency is code we run without reading. Supply-chain attacks often publish a malicious version and rely on projects picking it up within hours (SR-3, SA-11).

## Decision

- **Approval first:** a new dependency is proposed with its exact version and reason, approved, then added with a record if it's significant.
- **Exact pins** (`save-exact=true` in `.npmrc`), a committed `package-lock.json`, and `npm ci` in CI and on Cloudflare.
- **A week's age:** choose the newest release at least 7 days old; Dependabot uses a 7-day cooldown for the same reason.
- **Engines:** Node 22.23.4 or newer (Astro 7.4's requirement and a Node security release), pinned in `.nvmrc` and Cloudflare's `NODE_VERSION`.

Version choices made under this policy (2026-11-02):

| Package      | Pinned | Why not newer                                                                                  |
| ------------ | ------ | ---------------------------------------------------------------------------------------------- |
| `typescript` | 6.0.3  | TypeScript 7 isn't supported yet by `typescript-eslint` (< 6.1) or `@astrojs/check` (^5 or ^6) |
| `vitest`     | 4.1.12 | `@cloudflare/vitest-pool-workers` (planned for Phase 2) needs Vitest 4                         |
| `astro`      | 7.4.2  | 7.4.5 was released the same day                                                                |

## Consequences

- `npm audit` reports 11 moderate findings, all one advisory (GHSA-g3hv-75wg-m249, `minimatch` < 11.0.1) inside ESLint tooling: dev-only, never on untrusted input, and the fix is a major version ESLint doesn't support yet. Accepted below the "no high or critical" gate; Dependabot raises it when it's fixable.
- Updates arrive a week later than they could. A known exploited vulnerability is handled by a Dependabot security PR, which the cooldown doesn't delay.

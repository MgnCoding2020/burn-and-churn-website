# ADR-0016: Override minimatch to a fixed version

- **Status:** Accepted
- **Date:** 2026-11-02
- **Updates:** ADR-0008 (the accepted `npm audit` finding is now fixed)

## Context

GitHub Dependabot alert #1: `minimatch` < 11.0.1 has a denial-of-service issue through pattern amplification ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), CVSS 4.0 6.9, moderate). Our copy (10.2.6) arrives through ESLint 10.13.0 and typescript-eslint 8.72.1, which ask for minimatch 10. Dependabot can't update it, because no released ESLint accepts minimatch 11.

ADR-0008 accepted the risk because minimatch only runs in lint tooling, on patterns we write. That's still true, but a fix exists and costs one line.

## Decision

- `package.json` `overrides` forces `minimatch` to **11.0.1**, the oldest release containing the fix.
- This uses ADR-0008's security-fix exception to the 7-day rule: 11.0.1 was released 2026-10-27, 6 days before this change. Newer patch releases (up to 11.0.4, released the same day as this change) aren't needed for the fix.
- Verified before merging: `npm audit` reports 0 vulnerabilities; type checks, lint and all tests pass with the override.

## Consequences

- The Security tab's alert closes once `main` has the fixed lockfile.
- An override can hide an incompatibility. ESLint's own tests don't run against minimatch 11. Our lint run is the check: if lint behaves oddly after an ESLint update, this override is the first suspect.
- **Remove the override** once ESLint and typescript-eslint depend on minimatch 11 or later themselves. Dependabot's weekly ESLint updates are the trigger to check.

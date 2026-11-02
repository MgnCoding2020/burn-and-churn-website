# ADR-0009: CI gates, SHA-pinned actions, required checks on `main`

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Changes should reach `main` only after the same checks a reviewer would want, and the CI system itself is part of the attack surface (CM-3, CM-5, SA-11, RA-5).

## Decision

**Workflows:**

| Workflow          | Runs on             | Checks                                                                                      |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| CI → `check`      | PRs, `main`         | env examples, `astro check`, ESLint, Prettier, Vitest; `npm audit --audit-level=high`       |
| CI → `e2e`        | PRs, `main`         | Playwright against the built Worker (banner, headers, accessibility, 360px, `security.txt`) |
| CodeQL            | PRs, `main`, weekly | `security-extended` queries for JavaScript/TypeScript                                       |
| Dependency Review | PRs                 | blocks new high/critical vulnerabilities and GPL/AGPL licences                              |

**Hardening:** every action is pinned to a full commit SHA (a moved tag can't change what runs); `permissions: contents: read` by default, `security-events: write` only for CodeQL; `actions/checkout` with `persist-credentials: false`; telemetry off.

**Branch rule "Protect main"** (repository ruleset, created 2026-11-02): pull request required, the four checks above required, no force-push, no deletion, **no required approvals** and no bypass list.

**Repository settings** (confirmed 2026-11-02): secret scanning with push protection, dependency graph, Dependabot alerts and security updates, private vulnerability reporting. Code scanning uses the workflow above (default setup off).

## Consequences

- The owner works alone; requiring an approval would block every merge. Review happens by habit (the owner reviews each PR before saying "merge"), and the required checks are the enforced gate.
- The Cloudflare preview build is not a required check, so a Cloudflare outage can't block merges.
- `security.txt` expires on 2027-11-01; its test fails CI 30 days before, as a renewal reminder.

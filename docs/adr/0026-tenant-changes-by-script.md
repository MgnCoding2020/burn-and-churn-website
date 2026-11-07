# ADR-0026: Tenant changes for the website are made by scripts the owner runs

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The staff portal needs an Entra ID app registration, four app roles, admin consent, a certificate, and a role for each person on the roster. Done by hand in the admin centre that's about thirty clicks, repeated whenever someone joins, changes role or leaves, and again at every certificate rotation. Claude Code never holds tenant admin credentials (plan §16.1), so anything automated has to run as the owner.

## Decision

- **Scripts, run by the owner, signed in interactively.** `scripts/tenant/setup-staff-app.ps1` makes the certificate, registers the app, grants consent and assigns roles; `remove-staff-app.ps1` reverses it. They use Microsoft Graph through `Invoke-MgGraphRequest`, so only the `Microsoft.Graph.Authentication` module is needed.
- **Idempotent and previewable.** Every run compares the tenant with what it should be and changes only the difference. `-WhatIf` signs in read-only and lists the changes.
- **The hub's roster is the source of truth.** Users, groups and memberships are created by the hub's `provision-users.ps1` from `people.csv`; this repo's script only maps groups to app roles (plan §4.1) and keeps the assignments in step with the roster, including removing roles from people who leave (a leaver control, AC-2).
- **Nothing tenant-specific in the repository.** The tenant ID and domain come from the hub's git-ignored `.env`; output and logs use the fictional domain; the private key is written outside the repository (and into git-ignored `.dev.vars` only when asked). The `.gitignore` covers keys, certificates, `.env`, `.dev.vars` and the log folder, and GitHub push protection is on.
- **The manual runbook stays** as the explanation of each step and a fallback.

## Consequences

- Changes to the tenant are repeatable and reviewable in pull requests, and a run's log is evidence for the hub's CR-002.
- The scripts can't be tested in CI (no tenant there). They're checked offline (they parse, the helper functions are exercised, and the openssl commands run), and the owner's first `-WhatIf` run is the real test.
- Delegated sign-in with broad scopes (`Application.ReadWrite.All`) is used only for the length of a run; the script signs out when it finishes.

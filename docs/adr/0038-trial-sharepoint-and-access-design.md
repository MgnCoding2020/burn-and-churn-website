# ADR-0038: SharePoint, sync access and Conditional Access for the trial

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

The Microsoft 365 Business Premium trial starts on **2026-11-14**. It's 30 days, and data is deleted if it isn't moved to a paid subscription. Michael wants the trial spent on testing, not set-up, so everything that doesn't need the licence is built and dry-run first (plan Phase 6). Open questions from plan §5 and §17 were decided with him on 2026-11-10.

## Decision

### One site, per-list access

- **One communication site, `/sites/bc-operations`** ("Burn and Churn Operations"). It holds the website's six lists next to the hub's planned Operations content (hub §7.4).
- **The `bc-` prefix** matches the `grp-bc-` groups. Site URLs are unique per tenant, and Michael's `workspace` repo already used "operations".
- **Per-list access for the website, not whole-site.** Microsoft Graph's **`Lists.SelectedOperations.Selected`** application permission is generally available (checked 2026-11-10). It needs consent, an explicit grant on each list, and a token. The website reads **only its six lists**, plus the hidden User Information List for the Schedule's person column. It can't read the rest of the site, other sites or the directory. That's tighter than the plan's `Sites.Selected`, which grants a whole site.
- **A separate app, `bc-website-sync`**, with a certificate credential and that one permission, apart from `bc-website-staff` (sign-in). One app per job, the same reasoning as Stripe's keys (ADR-0035).
- **The list contract** (`docs/contracts/sharepoint-lists.{md,json}`) is the single source for the set-up script and the future sync. A unit test keeps the document, the JSON and the seed rows in step.
- **Menu prices are per size** (double shot, 12/16/20 oz), as plan §10.1 requires. Menu is seeded from `seed/menu.json`, so the list starts identical to today's site.

### The Schedule

- The Schedule is visible to Shift Lead and above only; baristas get no access to the list.
- Baristas will see **only their own shifts** through the staff portal (Phase 7): the website's copy, filtered to the signed-in person.
- Shift-change requests will live in the portal, approved by a Shift Lead or above, never their own, and audited, like restocks (ADR-0033).
- SharePoint views can't do this securely.

### Tooling

- The scripts run on **Windows PowerShell 5.1 with only `Microsoft.Graph.Authentication`** (`Invoke-MgGraphRequest`). PnP needs PowerShell 7 and its own app registration, which isn't installed.
- **Site creation uses Graph beta** `POST /sites` (communication site, checked 2026-11-10).
- **Group permissions on the site and lists are set by hand**, because Graph has no API for them. The permission pages, screenshotted, are the evidence (hub §7.4).

### Conditional Access and devices

- **Four policies, named `BC - …`, report-only first:**
  - MFA on the staff portal;
  - block legacy authentication;
  - sign-in every 8 hours on the staff portal;
  - **require a compliant (Intune-enrolled) device** for the staff portal (Michael: "something that would be in place in a real business").
- Every policy targets `grp-bc-all-staff` and excludes `grp-bc-break-glass`. The device policy also excludes `grp-bc-testers`.
- Other policies in the shared tenant are listed and never changed.

### Outside reviewer

- A **B2B guest** with their own account and MFA, given a read-only directory role (Global Reader, or Security Reader plus Reports Reader) by hand, with a written removal date.
- That's not a shared login, and not a standing role. Automatic expiry (PIM) needs Entra ID P2, which Business Premium doesn't include.

### Schedule

- Trial day 1 is **Saturday 2026-11-14** (runbook `docs/tenant-setup.md`, tests `docs/evidence/trial-test-plan.md`).
- The hub's CR-001/CR-003 cutover stays on Sunday 2026-11-15.
- Phase 5 (customers, Checkout, the site's own rate limiter) moves after the trial prep.

## Consequences

- **Break-glass first:** `grp-bc-break-glass` must exist, holding the tenant's break-glass accounts, before any policy is turned On. It's a pre-Saturday check, because no script creates it.
- **The User Information List is unverified for app-only access with a per-list grant** (T-SP-05). The contract names a fallback: a Choice column of employee IDs.
- **The device-compliance test needs a supported browser state:** Chrome with Microsoft's sign-in extension, or Edge. Incognito won't pass.
- **The scripts can't be run by Claude** (Graph sign-in needs Michael's window). They're checked by PowerShell's parser and by dot-sourced tests of their pure helpers. Michael runs `-WhatIf` before each real run.
- **When the trial ends:** if it lapses, the site keeps its last synced copy and staff sign-in still works on Entra ID Free. Turn the BC policies Off before the end date.

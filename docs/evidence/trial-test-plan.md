# Trial test plan: Microsoft 365 Business Premium (from 2026-11-14)

Plan §3.4 and §5; ADR-0038; runbook `docs/tenant-setup.md`. **Every test has an expected result written before it's run.** Each result is saved with its date in `docs/evidence/<date>-trial/` (screenshots redacted: tenant domain, IDs, IPs), and the test is ticked here with that date. A result that differs from what was expected is recorded as a finding, not edited to fit.

Status: ☐ not run · ✅ passed (date, evidence) · ❌ failed (finding)

## Licences

| ID       | Test                                        | Expected                                                                | Status |
| -------- | ------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| T-LIC-01 | Trial started; recurring billing turned off | Product page shows the trial, its end date, recurring billing **Off**   | ☐      |
| T-LIC-02 | `provision-users.ps1 -AssignLicenses`       | 21 of 25 licences used; no admin, break-glass or guest account licensed | ☐      |

## SharePoint and the website's access

| ID      | Test                                                                                                  | Expected                                                                                                                                                                                                             | Status |
| ------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T-SP-01 | `setup-sharepoint.ps1 -Seed`                                                                          | `/sites/bc-operations` exists with six lists; Menu has 20 drinks, Store Hours 7 days, Inventory 12 supplies                                                                                                          | ☐      |
| T-SP-02 | Run `setup-sharepoint.ps1` again                                                                      | Everything "exists", nothing created twice, no MISMATCH                                                                                                                                                              | ☐      |
| T-SP-03 | `node scripts/tenant/check-sync-access.mjs`                                                           | Token carries **only** `Lists.SelectedOperations.Selected`; **200** on the six lists; **403** on the site's documents, the tenant's root site and the directory. The "list of lists" row is recorded for information | ☐      |
| T-SP-04 | Group permissions by hand; then sign in to SharePoint as **Ethan (Barista)** and open each list       | Ethan can read Menu, Store Hours, Announcements, Shift Notes, Inventory; can't edit any; **Schedule: access denied**. As **Mia (Shift Lead)**: can edit Shift Notes, Inventory, Schedule; can't edit Menu            | ☐      |
| T-SP-05 | The Schedule's person column through the sync app                                                     | The app can read the User Information List (200 in T-SP-03) and resolve a schedule row's person to an email. **If not:** switch to the contract's fallback (a Choice column of employee IDs) and record why          | ☐      |
| T-SP-06 | (Phase 7 code) Change a price in SharePoint as Daniel (Manager), then **Publish** in the staff portal | Public menu and register show the new price; the run is in `sync_runs`                                                                                                                                               | ☐      |
| T-SP-07 | (Phase 7 code) Put an invalid row in Menu (no price)                                                  | That row is skipped and reported; the rest publish; the site keeps the last good copy of it                                                                                                                          | ☐      |
| T-SP-08 | (Phase 7 code) A barista opens **My shifts**                                                          | Only their own shifts; a change request goes to a Shift Lead, who can't approve their own                                                                                                                            | ☐      |

## Identity

| ID      | Test                                                        | Expected                                                                                                                              | Status |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T-ID-01 | `setup-staff-app.ps1 -ByGroup`                              | The four groups hold the four roles; no per-person assignments left (except non-roster testers, left alone)                           | ☐      |
| T-ID-02 | Add Ethan to `grp-bc-shift-leads`, sign in, then remove him | Portal shows **Role: Shift Lead** and the Cash screen; after removal and a fresh sign-in, Barista again (plan §5)                     | ☐      |
| T-ID-03 | Sign in with an account in no `grp-bc-` role group          | **Refused by Entra** ("not assigned to the application"). Also re-test the open finding of 2026-11-07 (a no-role account got a token) | ☐      |

## Conditional Access

| ID      | Test                                                           | Expected                                                                                                                                                                                           | Status |
| ------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T-CA-01 | Policies report-only for a day; Sign-in logs → Report-only tab | Each BC policy shows "Report-only: success/failure/not applied" on staff sign-ins; break-glass not evaluated                                                                                       | ☐      |
| T-CA-02 | MFA policy **On**; sign in as a staff member                   | MFA required; sign-in log shows the policy applied                                                                                                                                                 | ☐      |
| T-CA-03 | Legacy authentication block **On**                             | Sign-in log for any legacy attempt shows it blocked; in practice, the policy shows in sign-in details as applied to `grp-bc-all-staff`                                                             | ☐      |
| T-CA-04 | Sign-in frequency 8 hours **On**                               | Sign-in details show the session control; a sign-in older than 8 hours is asked to sign in again (verify once, record the time)                                                                    | ☐      |
| T-CA-05 | Device compliance **On**                                       | From the enrolled, compliant laptop in Chrome with Microsoft's sign-in extension (or Edge): allowed. From Incognito or an unenrolled device: **blocked**. A `grp-bc-testers` member: not evaluated | ☐      |
| T-CA-06 | Turn a policy Off with `-State Off`, then On again             | The policy is switchable; the change appears in the Entra audit log                                                                                                                                | ☐      |

## Intune

| ID       | Test                                                   | Expected                                                                        | Status |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------ |
| T-INT-01 | Enrol the laptop; create the minimal compliance policy | Device listed in Intune as **Compliant**; policy assigned to `grp-bc-all-staff` | ☐      |

## Audit and logs

| ID       | Test                                                                    | Expected                                                                                            | Status |
| -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| T-AUD-01 | Purview audit search, day 2, for SharePoint activity on `bc-operations` | Day 1's list creation, permission changes and item edits are found; export saved                    | ☐      |
| T-AUD-02 | Entra audit log for `bc-website-sync`                                   | App creation, certificate, consent to `Lists.SelectedOperations.Selected`; matches the script's log | ☐      |

## Outside reviewer (mentor), optional

| ID       | Test                                                                                                                                                              | Expected                                                                                                                                                                             | Status |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| T-MEN-01 | Invite the mentor as a **B2B guest**; add to `grp-bc-testers`; assign **Global Reader** (or Security Reader + Reports Reader) by hand with a written removal date | They sign in with their own account and MFA; can view users, groups, app registrations, Conditional Access and sign-in logs; **can't change anything** (a change attempt is refused) | ☐      |
| T-MEN-02 | On the removal date: remove the role and the guest                                                                                                                | Gone from the directory; recorded in the IAM lab's next access review and the hub (CR-004 guest pattern)                                                                             | ☐      |

Notes:

- Automatic expiry for role assignments (PIM) needs **Entra ID P2**, which Business Premium doesn't include. Re-check when inviting.
- The tenant is shared, so a reader role also shows Michael's non-Burn-and-Churn lab objects. Tell the reviewer before inviting.

## Before day 30

| ID       | Test                                               | Expected                                                                            | Status |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| T-END-01 | Export every piece of evidence above into the repo | All rows ticked or recorded as findings; exports redacted                           | ☐      |
| T-END-02 | Decide: buy seats or let it lapse                  | Recorded in `docs/tenant-setup.md`; if lapsing, BC policies Off before the end date | ☐      |

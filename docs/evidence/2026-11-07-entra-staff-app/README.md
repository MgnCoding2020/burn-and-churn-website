# Evidence: staff sign-in app registered in Entra ID (2026-11-07)

**Lab-verified 2026-11-07.** Hub change record **CR-002**; plan §4.1; ADR-0026. Made by Michael running `scripts/tenant/setup-staff-app.ps1 -NewCertificate -WriteDevVars`, signed in as tenant admin, after the hub's `provision-users.ps1` created the 20 active staff from `people.csv` (hub CR-001 log, same day).

Redaction: tenant ID, application ID, object IDs and the real tenant domain are covered with solid boxes or never shown. User principal names appear only truncated or with the fictional domain. The app role IDs are also in the public script.

| File                               | Shows                                                                                                        | Control    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| `01-app-registration-overview.png` | `bc-website-staff`: single tenant ("My organization only"), 1 certificate and 0 secrets, 2 web redirect URIs | IA-5, AC-3 |
| `02-app-roles.png`                 | The four app roles (`Staff.Owner`, `Staff.Manager`, `Staff.ShiftLead`, `Staff.Barista`), enabled             | AC-3, AC-6 |
| `03-api-permissions.png`           | Microsoft Graph delegated `openid` and `profile` only, admin consent granted                                 | AC-6       |
| `04-enterprise-app-properties.png` | Enterprise app: **Assignment required = Yes** (people without a role are refused by Entra)                   | AC-3       |
| `05`, `06-role-assignments-*.png`  | 20 assignments: 1 Owner, 1 Manager, 3 Shift Leads, 15 Baristas, matching `people.csv`                        | AC-2, AC-6 |
| `07-groups.png`                    | The five `grp-bc-` security groups                                                                           | AC-2       |
| `08`, `09-users-*.png`             | The 20 staff accounts, company "Burn and Churn Coffee"                                                       | AC-2       |
| `setup-staff-app-log.csv`          | The script's own log: each action with its timestamp (home folder path generalised)                          | AU-3, CM-3 |

**Not shown, deliberately:** the certificate's private key and the temporary passwords. The certificate expires 2027-11-07 (`docs/secrets-inventory.md`).

**Still to test (Phase 2 checklist, plan §5):** sign-in as a barista lands on `/staff/` with role Barista; a tenant account with no role is refused by Entra. Both need the sign-in routes, which are being built next.

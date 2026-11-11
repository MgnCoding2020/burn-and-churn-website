# Tenant set-up: the Business Premium trial (Saturday 2026-11-14)

For Michael. Plan §3, §4.1, §5; ADR-0038; the list contract `docs/contracts/sharepoint-lists.md`; the tests in `docs/evidence/trial-test-plan.md`. The hub's CR-001/CR-003 cutover stays on **Sunday 2026-11-15** (hub CLAUDE.md §7.5).

- **Run everything from the website folder**, in your own VS Code PowerShell terminal. Graph sign-in needs your window; Claude can't run it (Lessons, 2026-11-07).
- **Choose "No, this app only"** at the "sign in to all apps" prompt.
- **Each script has `-WhatIf`:** it signs in read-only and lists every change without making it. Run it first, read it, then run for real.

## The trial's terms (checked 2026-11-01; re-check on the day)

- 30 days, 25 licences.
- **Data not moved to a paid subscription before it ends is deleted.**
- The trial **converts to paid by default** unless recurring billing is turned off ([Microsoft Learn](https://learn.microsoft.com/microsoft-365/commerce/extend-your-trial)).

## Before Saturday (no licence needed)

| #   | Do                                                                                                                           | Why                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | `.\scripts\tenant\setup-conditional-access.ps1 -WhatIf`: read the "other" policies it lists                                  | The cyber-homelab's report-only policies (`require-mfa-all-users`, risk-based) start evaluating Burn and Churn users once P1 returns. Decide now: leave them, or turn them off |
| P2  | Check **Security defaults** (Entra admin centre → Overview → Properties → Manage security defaults) and write down its state | Conditional Access can't be turned on while security defaults are on (plan §17)                                                                                                |
| P3  | Find the tenant's **break-glass** accounts. Create the security group **`grp-bc-break-glass`** by hand and add them          | Every BC policy excludes it. **No policy goes On without it** (plan §4.1). The hub leaves break-glass manual (provision-users.ps1, "out of scope")                             |
| P4  | `.\scripts\tenant\setup-staff-app.ps1 -ByGroup -WhatIf`                                                                      | Shows the switch from per-person roles to the four groups, without making it                                                                                                   |
| P5  | In the hub's `.env`, leave `BC_LICENSE_SKU` empty until the trial exists (step 3 fills it)                                   |                                                                                                                                                                                |
| P6  | Pick your devices for Intune: this laptop, and your phone if you want it                                                     | The device-compliance test (T-CA-05)                                                                                                                                           |

## Saturday: day 1

### 1. Start the trial and turn off auto-renewal

1. In the Microsoft 365 admin centre: **Billing → Purchase services**, search for **Microsoft 365 Business Premium**, then **Start free trial**.
2. **Straight away:** **Billing → Your products → Microsoft 365 Business Premium → Recurring billing → Off.**
3. Write the **expiry date** in the table at the end of this file.
4. 📸 The product page showing the trial, its end date, and recurring billing off (`T-LIC-01`).

### 2. Wait for SharePoint

A new SharePoint service can take from minutes to a few hours. When the SharePoint admin centre opens (admin centre → **Show all → SharePoint**), it's ready.

### 3. Licences

1. Run `Connect-MgGraph -Scopes Organization.Read.All` then `Get-MgSubscribedSku | Select-Object SkuPartNumber, ConsumedUnits, @{n='Total';e={$_.PrepaidUnits.Enabled}}`. Business Premium normally shows as **`SPB`**: check, don't assume.
2. Put that value in the hub's `.env` as `BC_LICENSE_SKU`.
3. From the **hub** folder: `.\tools\tenant\provision-users.ps1 -AssignLicenses -DryRun`, then without `-DryRun`.
   - 21 people (20 staff and Riley Morgan) of 25 seats.
   - Admin and break-glass accounts are never licensed.
4. 📸 Licences page: 21 of 25 used (`T-LIC-02`).

### 4. The SharePoint site and lists

1. `.\scripts\tenant\setup-sharepoint.ps1 -WhatIf`
2. `.\scripts\tenant\setup-sharepoint.ps1 -Seed`
   - Creates `/sites/bc-operations` ("Burn and Churn Operations", a communication site you own).
   - Creates the six lists from the contract.
   - Seeds Menu (20 drinks, matching today's site), Store Hours (7 days) and Inventory (12 supplies).
3. 📸 The site's **Site contents** page listing the six lists (`T-SP-01`). The log in `scripts/tenant/logs/` records every list ID.

### 5. Group permissions (by hand, about 15 minutes)

Graph can't set SharePoint permissions for groups, so this step is done in the browser. The permission pages themselves are the evidence of least privilege (hub §7.4).

**Site:** ⚙ **Site permissions → Advanced permissions settings**:

- **Burn and Churn Operations Visitors** → **New → Add users**: `grp-bc-all-staff`.
- **Burn and Churn Operations Members** → `grp-bc-managers`, `grp-bc-owners`.
- Remove anyone else except you, the owner.
- 📸 (`T-SP-04a`)

**Each list:** open the list → ⚙ **List settings → Permissions for this list → Stop inheriting permissions**. Remove the three default groups, then **Grant permissions** as in this table (the contract has the same table). 📸 each permission page (`T-SP-04b` to `T-SP-04g`).

| List                             | Read               | Edit                                                     |
| -------------------------------- | ------------------ | -------------------------------------------------------- |
| Menu, Store Hours, Announcements | `grp-bc-all-staff` | `grp-bc-managers`, `grp-bc-owners`                       |
| Shift Notes, Inventory           | `grp-bc-baristas`  | `grp-bc-shift-leads`, `grp-bc-managers`, `grp-bc-owners` |
| **Schedule**                     | **nobody else**    | `grp-bc-shift-leads`, `grp-bc-managers`, `grp-bc-owners` |

**The sync app's grants** (step 6) also show on these pages as an app. That's expected.

### 6. The website's read access (per list)

1. `.\scripts\tenant\setup-sync-app.ps1 -NewCertificate -WhatIf`
2. `.\scripts\tenant\setup-sync-app.ps1 -NewCertificate -WriteDevVars`
   - Creates app `bc-website-sync`, with a certificate and one permission (`Lists.SelectedOperations.Selected`).
   - Grants it **read** on the six lists and the hidden User Information List.
   - Writes its values into `.dev.vars` (values not shown).
3. `node scripts/tenant/check-sync-access.mjs`
4. 📸 The output: **PASS 200** on the six lists and the User Information List; **PASS 403** on the site's documents, the root site and the directory (`T-SP-03`, `T-SP-05`).

### 7. Roles by group

1. `.\scripts\tenant\setup-staff-app.ps1 -ByGroup -WhatIf`, then without `-WhatIf`.
2. The four groups now carry the four app roles, and the per-person assignments are removed (`T-ID-01`).
3. Role change test (`T-ID-02`):
   - add Ethan Brooks to `grp-bc-shift-leads` in the Entra admin centre;
   - sign in as Ethan;
   - the portal shows **Role: Shift Lead** and Cash appears;
   - remove him again.

### 8. Conditional Access (report-only), Intune and audit

1. `.\scripts\tenant\setup-conditional-access.ps1 -WhatIf`, then without `-WhatIf`: four **BC -** policies, **report-only**.
2. **Intune** (Business Premium includes it): enrol your laptop.
   - Windows **Settings → Accounts → Access work or school → Connect**, signing in with your Burn and Churn admin-capable account. Choose the enrolment option the Intune admin centre recommends for a personal device.
   - In the **Intune admin centre → Devices → Compliance → Create policy (Windows 10 and later)**: a minimal policy, for example require a password and a supported OS. Assign it to `grp-bc-all-staff`.
3. **Device check in the browser:** Chrome passes the device state to Entra only with Microsoft's **"Microsoft Single Sign On"** extension (or use Edge), and **not in Incognito**, where extensions are off. Re-check Microsoft's current requirement before `T-CA-05`.
4. **Audit:** the Purview portal → **Audit**. If it offers **Start recording user and admin activity**, start it. Search 24 hours later for today's SharePoint changes (`T-AUD-01`).
5. **Next day:** Entra → **Sign-in logs**, filter app `bc-website-staff`, tab **Report-only**. Then `setup-conditional-access.ps1 -State On` (`T-CA-01` to `T-CA-05`).

### 9. Record it

- The hub's CR-002 log: the trial started, licences, the site, the sync app, Conditional Access report-only.
- `docs/secrets-inventory.md`: the `bc-website-sync` certificate and its expiry.

## Later in the trial

The Phase 7 code (sync, Publish, My shifts, low stock) is tested against these lists as it's built. See the test plan.

## Before day 30

Plan §3.5:

1. Export all evidence (sign-in logs, audit searches, Conditional Access policy JSON, screenshots).
2. Decide whether to buy seats or let the trial lapse, and record the outcome below.
3. If it lapses:
   - staff sign-in keeps working on Entra ID Free;
   - the website keeps its last synced copy;
   - turn the BC Conditional Access policies Off, because Free can't run them.

## Record

|                              |              |
| ---------------------------- | ------------ |
| Trial started                |              |
| Trial expires                |              |
| Recurring billing            | Off (date: ) |
| Licence SKU                  |              |
| Site created                 |              |
| Sync app certificate expires |              |
| Conditional Access On        |              |
| Outcome at day 30            |              |

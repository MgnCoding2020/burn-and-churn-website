# Runbook: register the staff sign-in app in Entra ID

Creates **`bc-website-staff`**, the Entra ID app the staff portal signs in with (plan §4.1, website Phase 2). This is the website's first change to a company system, under hub change record **CR-002**. Works on **Entra ID Free**: no Business Premium trial needed.

Time: about 30 minutes. Done by the owner (Claude Code never holds tenant admin credentials).

**Privacy:** none of the values below are pasted into chat or committed. They go only into your local `.dev.vars` (git-ignored) and, later, Cloudflare secrets. The private key never leaves your machine except into those.

## The scripted way (recommended)

`scripts/tenant/setup-staff-app.ps1` does steps 1 to 8 below for you, and is safe to run again at any time. It reads the tenant ID and domain from the hub's git-ignored `.env`, and who gets which role from the hub's `people.csv`. Users and groups themselves come from the hub's `tools/tenant/provision-users.ps1`; run that first.

In Windows PowerShell, from the repository root:

```powershell
# Once: the Graph sign-in module (no other Graph modules are needed)
Install-Module Microsoft.Graph.Authentication -Scope CurrentUser

# 1. Look first: signs in read-only and lists every change it would make
.\scripts\tenant\setup-staff-app.ps1 -NewCertificate -WhatIf

# 2. Do it: makes the certificate in Documents\burn-and-churn-secrets, registers the app,
#    grants consent, assigns roles and fills in .dev.vars
.\scripts\tenant\setup-staff-app.ps1 -NewCertificate -WriteDevVars
```

A browser window asks you to sign in with your admin account and approve the permissions the script uses. What it does on a re-run:

- **Roles follow `people.csv`.** Someone added to the roster gets their role; a changed group changes the role; someone marked Terminated loses it. People not in the tenant yet are listed and skipped. Assignments for anyone not in `people.csv`, such as a guest tester, are listed and left alone.
- **Phase 7 (Entra ID P1):** `-ByGroup` assigns the four `grp-bc-` groups instead of each person, and removes the per-person assignments.
- **Yearly certificate rotation:** move the old files aside, then `-NewCertificate -ReplaceCertificate -WriteDevVars`.
- **To undo everything:** `.\scripts\tenant\remove-staff-app.ps1 -WhatIf`, then without `-WhatIf`. It asks before each deletion; a deleted app can be restored for 30 days.

Each run writes a log to `scripts/tenant/logs/` (git-ignored; fictional domain only). Then do step 9 (record it). The manual steps below do the same thing by hand.

## Before you start

- Sign in to the [Microsoft Entra admin centre](https://entra.microsoft.com) with an account that can register applications and grant consent (your admin account).
- Decide **who signs in for the first test** (see "Who to assign" at the end).

## 1. Make the certificate (the app's credential)

The site proves it's the real app with a certificate, not a password (plan §4.1). In **Git Bash**, in a folder **outside the repository** (for example `Documents\burn-and-churn-secrets\`):

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout bc-website-staff.key -out bc-website-staff.crt -subj "/CN=bc-website-staff"
# The Worker's crypto needs the key in PKCS#8 form:
openssl pkcs8 -topk8 -nocrypt -in bc-website-staff.key -out bc-website-staff.pkcs8.pem
```

You now have `bc-website-staff.crt` (public, uploaded to Entra) and `bc-website-staff.pkcs8.pem` (private, never shared). Note the expiry date (one year) for `docs/secrets-inventory.md`.

## 2. Register the app

Entra admin centre → **Identity → Applications → App registrations → New registration**:

| Field                   | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| Name                    | `bc-website-staff`                                                   |
| Supported account types | **Accounts in this organizational directory only** (single tenant)   |
| Redirect URI            | Platform **Web**: `http://localhost:8787/api/v1/auth/staff/callback` |

Click **Register**. On the app's **Overview**, note the **Application (client) ID** and **Directory (tenant) ID**.

## 3. Add the production redirect URI

App → **Authentication** → under **Web** → **Add URI**:

`https://burn-and-churn-website.naultmichael.workers.dev/api/v1/auth/staff/callback`

Leave **Implicit grant** (access tokens, ID tokens) **unticked**: the site uses the authorization code flow with PKCE. Save.

## 4. Upload the certificate

App → **Certificates & secrets → Certificates → Upload certificate** → choose `bc-website-staff.crt` → description `website staff sign-in 2026` → Add. Note the **Thumbprint** shown.

Don't create a client secret.

## 5. Permissions: sign-in only

App → **API permissions**:

1. Remove the default **Microsoft Graph → User.Read** (the site doesn't read profiles from Graph).
2. **Add a permission → Microsoft Graph → Delegated** → tick **openid** and **profile** → Add.
3. **Grant admin consent** for your directory (user consent is turned off tenant-wide, hub PR-013).

## 6. Create the four app roles

App → **App roles → Create app role**, four times:

| Display name | Allowed member types | Value             | Description                                    |
| ------------ | -------------------- | ----------------- | ---------------------------------------------- |
| Barista      | Users/Groups         | `Staff.Barista`   | Takes orders and payments at the counter       |
| Shift Lead   | Users/Groups         | `Staff.ShiftLead` | Runs a shift: order board, sold-out items      |
| Manager      | Users/Groups         | `Staff.Manager`   | Menu, refunds, audit log                       |
| Owner        | Users/Groups         | `Staff.Owner`     | Everything, including AI and payment summaries |

The **Value** must match exactly; the site reads it from the sign-in token.

## 7. Require assignment, then assign people

Entra admin centre → **Identity → Applications → Enterprise applications → `bc-website-staff`**:

1. **Properties → Assignment required? → Yes** → Save. People not assigned are refused by Entra itself (plan §5 test "sign in as a non-member").
2. **Users and groups → Add user/group** → pick a user → **Select a role** → Assign. On Entra ID Free, assign **users** (assigning **groups** needs P1, which comes with the Business Premium trial in Phase 7).

## 8. Put the values in `.dev.vars` (local only)

In the repository's `.dev.vars` (copied from `.dev.vars.example`):

```bash
ENTRA_STAFF_TENANT_ID=<Directory (tenant) ID>
ENTRA_STAFF_CLIENT_ID=<Application (client) ID>
ENTRA_STAFF_CERT_THUMBPRINT=<Thumbprint from step 4>
ENTRA_STAFF_CERT_PRIVATE_KEY="<contents of bc-website-staff.pkcs8.pem, with line breaks written as \n>"
```

Then tell Claude "the app is registered". Claude doesn't need the values themselves.

## 9. Record it

- Hub **CR-002 log**: "Entra ID app `bc-website-staff` registered (single tenant, certificate credential, four app roles, assignment required)", with the date.
- `docs/secrets-inventory.md`: the certificate (name, where it lives, created, expires).
- Evidence: screenshots of the app's **App roles**, **API permissions** and the enterprise app's **Properties** (assignment required) into `docs/evidence/<date>-entra-staff-app/`, after checking they show no tenant ID or real email addresses.

## Who to assign (decide before step 7)

The Burn and Churn staff accounts don't exist in the tenant yet: the hub creates them from `people.csv` on the CR-001 build day (planned 2026-11-15). Options for testing sooner:

| Option                                         | What                                                                                                                                                                                  | Trade-off                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **A. Run the hub's pilot early** (recommended) | Create the CR-001 **pilot** accounts with the hub's `provision-users.ps1` (Owner, Store Manager, IT Technician, plus one barista), and record it in the CR-001 log as the pilot phase | Real roster names, so evidence matches the program; moves part of CR-001 earlier, recorded honestly |
| B. Two temporary test users                    | e.g. `test.barista` and `test.manager`, deleted after Phase 2                                                                                                                         | Faster, but they aren't in `people.csv`, so evidence can't be used for the program                  |

Either way, also keep one account **not** assigned to the app, to prove Entra refuses it.

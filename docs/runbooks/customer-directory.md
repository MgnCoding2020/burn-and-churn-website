# Runbook: the customer directory (Entra External ID)

Plan §4.2, Phase 5. Customers get their **own directory**, separate from the staff tenant. A customer account can never become a staff account, and staff Conditional Access never touches customers. Michael runs every step here himself. Nothing in this runbook writes an ID, domain or address into the repository.

**Facts checked 2026-11-11** (Microsoft Learn and Microsoft's pricing page):

- **Free tier:** the first **50,000 monthly active users are free**.
- **SMS codes are a paid add-on**, so this site uses **email one-time codes only**.
- **The 30-day trial option is not used.** It needs no subscription but expires; this directory is linked to the pay-as-you-go Azure subscription instead.
- **Creating the directory can take up to 30 minutes.**
- **Country/region can't be changed** after creation.

## Parts A to C: create the directory, by script (about 5 minutes, then a wait)

`scripts/tenant/setup-customer-directory.ps1` (ADR-0041) does in one run what the portal steps did:

- registers the resource provider;
- creates resource group `rg-bc-customers`;
- creates the directory **Burn and Churn Customers**, with data in the United States, on the pay-as-you-go subscription (no 30-day trial);
- adds budget `bc-budget`: $5 a month, alerts at 80% and 100%.

**Once, install Microsoft's Azure sign-in module** (Windows PowerShell, your own VS Code terminal):

```powershell
Install-Module Az.Accounts -Scope CurrentUser
```

Answer **Y** if asked to trust the PowerShell Gallery or install NuGet.

**You need three things, typed only into your own terminal:**

- **Subscription ID:** portal.azure.com → **Subscriptions** → your pay-as-you-go one.
- **Domain prefix:** 1 to 26 letters or digits, for example something with `bc` and `customers`. It becomes `<prefix>.onmicrosoft.com` and **can't be changed later**. Keep it out of the repo and chat.
- **Alert email:** where budget alerts go.

**Make the prefix distinctive.** A common word such as `customer` is already taken worldwide: creation then fails within seconds (seen 2026-11-12), and the failed entry must be deleted before trying again (the script prints the command).

**Type the values one line at a time.** Pasting all three `Read-Host` lines at once skips the prompts:

```powershell
$sub = Read-Host 'Subscription ID'
$prefix = Read-Host 'Domain prefix'
$email = Read-Host 'Budget alert email'
```

**Sign in to the staff tenant by name.** Without a tenant, Windows can open the personal-account page, where a work account "doesn't exist":

```powershell
Connect-AzAccount -Tenant <staff-tenant>.onmicrosoft.com -Subscription $sub.Trim()
```

- At the account picker, choose **Work or school account**, not "Microsoft account".
- Use your admin account, the one that owns the subscription. Not a break-glass account.
- If asked to "sign in to all apps", choose **No, this app only**.

**Dry run first.** It reuses that sign-in:

```powershell
.\scripts\tenant\setup-customer-directory.ps1 -SubscriptionId $sub.Trim() -DomainPrefix $prefix.Trim() -AlertEmail $email.Trim() -WhatIf
```

- **What you should see:** your subscription's name, then a "What if" line for each step.

**Then for real**, the same command without `-WhatIf`. It prints a line every 30 seconds while the directory is created, which can take up to 30 minutes. If it stops waiting first, run it again: it picks up the same directory.

**At the end it shows the domain and the tenant ID, and saves the ID as `ENTRA_CUSTOMER_TENANT_ID` in `.dev.vars`** (git-ignored). The seed and remove scripts read it from there, and the website's customer sign-in will too. Keep it out of chat and tracked files.

**Check it** (optional): open Chrome Incognito at **entra.microsoft.com**, then gear → **Directories + subscriptions**. **Burn and Churn Customers** is listed. You're its Global Administrator.

## Part D: add the 100 demo customers

These are display only (see `scripts/tenant/seed-customers.ps1`):

- **Addresses:** `@example.com`, a domain reserved for documentation, so no email can reach anyone.
- **Phone numbers:** `555-0100` to `555-0199`, the range reserved for fiction.
- **Passwords:** random, never shown or saved.
- **They can't sign in.** Real sign-in is tested with your own addresses (Part F).

In a **new** VS Code terminal (Windows PowerShell), from the repo folder. Not the one that ran the directory script: its Azure module clashes with the Graph module ("Method not found").

```powershell
Import-Module Microsoft.Graph.Authentication
.\scripts\tenant\seed-customers.ps1 -WhatIf
```

- **Signing in:** a sign-in window opens. Choose **Work or school account** and use the same admin account (it's the new directory's Global Administrator). If asked to "sign in to all apps", choose **No, this app only**. If asked to consent to the permission, accept it: it's for this directory only.
- **What you should see:** `directory Burn and Churn Customers (customer directory)`, `existing 0`, and a "What if" line per customer.

Then run it for real:

```powershell
.\scripts\tenant\seed-customers.ps1
```

Expected: `added 100 demo customers`. Running it again adds nothing.

**Safety:** the script refuses to run unless Graph reports a customer directory (`tenantType` = `CIAM`). It also refuses the staff tenant's ID (from the hub's `.env`), so it can't add these people to the staff tenant by mistake.

**Removing them** at the end of the project: `.\scripts\tenant\remove-customers.ps1`. It deletes only accounts tagged as demo customers with `@example.com` addresses. Your own test accounts are never touched.

**Deleting the directory** at the very end (no script, ADR-0041):

1. Remove the demo customers, your test accounts and the app registrations.
2. In the Entra admin center, go to **Entra ID** → **Overview** → **Manage tenants**.
3. Select **Burn and Churn Customers**, then **Delete**. Microsoft lists anything still blocking the deletion.

## Part E: one screenshot (the only evidence needed for the directory)

In the customer directory, go to **Entra ID** → **Users**. Screenshot the list showing the demo customers. Save it to `burn-and-churn-design\originals` as usual. If any row shows your own address, it'll be boxed out on the repo copy.

## Part F: customer sign-in (ADR-0042)

`scripts/tenant/setup-customer-app.ps1` creates the website's customer app `bc-website-customers` with its own certificate, and the user flow `bc-customers-sign-up-sign-in` (email one-time codes only, sign-up allowed). It reads the tenant ID from `.dev.vars`.

In a **new** terminal (not one that ran the directory script):

```powershell
Import-Module Microsoft.Graph.Authentication
.\scripts\tenant\setup-customer-app.ps1 -NewCertificate -WhatIf
```

- **Signing in:** choose **Work or school account** and use your admin account. Accept the permission consent if asked; it's for the customer directory only.
- **What you should see:** `checked directory Burn and Churn Customers (customer directory)` and `checked provider EmailOtpSignup-OAUTH`, then "would" lines for the certificate, app, enterprise app, consent and user flow.

Then for real, writing the values into `.dev.vars`:

```powershell
.\scripts\tenant\setup-customer-app.ps1 -NewCertificate -WriteDevVars
```

**Try it locally:** run `npm run build` and `npx wrangler dev`, open `http://localhost:8787/account/`, and select **Continue with email**. On Microsoft's page, choose to create an account and use one of your own addresses. Enter the code from your inbox and your name. You land on **Your account** with your name.

Your address only ever exists in the directory: never in the repo, a script or chat. Any screenshot that shows it is boxed out.

**Delete my data (ADR-0043).** The same script also creates the erasure app `bc-website-erasure` (delete-only permission, its own certificate). If you ran it before this was added, run it once more with `-NewCertificate -WriteDevVars`: existing parts show as `exists`, and only the erasure app and its certificate are new.

Test it with your **second** address, a throwaway account:

1. Sign up with it locally.
2. On **Your account**, tick **I understand this can't be undone** and select **Delete my account and data**.
3. You land on "Your account is deleted". In the Entra admin center (customer directory) → **Users**, the account is gone, and it isn't under **Deleted users** either.

If the page says "We couldn't delete your account", the `wrangler dev` terminal shows a `customer.erase_failed` line with the step and status: paste it.

**Production** (when you're ready for it to go live): set the four values as Worker secrets with `npx wrangler secret put` (names in ADR-0042). Paste each value at the prompt, never into chat.

## After Parts A to C

Tell Claude the directory exists. It's a new system for the program, so it gets recorded in the hub: CR-002's log, `systems.csv`, and the Microsoft vendor scope (V-003). It's recorded with no IDs.

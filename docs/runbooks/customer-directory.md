# Runbook: the customer directory (Entra External ID)

Plan §4.2, Phase 5. Customers get their **own directory**, separate from the staff tenant. A customer account can never become a staff account, and staff Conditional Access never touches customers. Michael does every step here himself. Nothing in this runbook writes an ID, domain or address into the repository.

**Facts checked 2026-11-11** (Microsoft Learn and Microsoft's pricing page):

- **Free tier:** the first **50,000 monthly active users are free**.
- **SMS codes are a paid add-on**, so this site uses **email one-time codes only**.
- **The 30-day trial option is not used.** It needs no subscription but expires; this directory is linked to the pay-as-you-go Azure subscription instead.
- **Creating the directory can take up to 30 minutes.**
- **Country/region can't be changed** after creation.

## Part A: create the directory (about 10 minutes, then a wait)

1. Open Chrome (Incognito) and go to **entra.microsoft.com**.
2. Sign in with your admin account, the one that owns the pay-as-you-go Azure subscription. Not a break-glass account.
3. In the left menu, go to **Entra ID** → **Overview** → **Manage tenants**, then select **Create**.
4. Choose **External**, then **Continue**.
5. Choose **Use Azure Subscription**, not the 30-day free trial.
6. On the **Basics** tab, fill in three fields:
   - **Tenant name:** `Burn and Churn Customers`
   - **Domain name:** your choice, for example something with `bc` and `customers` in it. This becomes the directory's own `…onmicrosoft.com` address. **Keep it out of the repo**, like the staff tenant's.
   - **Country/Region:** United States.
7. **Next: Add a subscription**, then fill in the **Add a subscription** tab:
   - **Subscription:** your pay-as-you-go subscription.
   - **Resource group:** **Create new** → `rg-bc-customers` → OK.
   - **Location:** East US (if asked).
8. **Next: Review + Create** → **Create**. Watch the bell icon (Notifications). It can take up to 30 minutes.

## Part B: check it and note the ID

1. Open the gear icon (**Settings**), then **Directories + subscriptions**. Find **Burn and Churn Customers** and select **Switch**.
2. Go to **Home** and check the **Billing** section. A subscription ID there means it's linked. If you see **Click here to upgrade** instead, follow it and select **Add Subscription**.
3. Go to **Overview**. Copy the **Tenant ID** into your password manager's notes or a local note. It goes in `.dev.vars` later. Never paste it into chat or a tracked file.

## Part C: a spending guard (5 minutes)

Even on the free tier, put a ceiling on the subscription so a mistake can't run up a bill.

1. Go to **portal.azure.com**, switch back to your usual directory, and open **Cost Management** → **Budgets** → **Add**.
2. Set the scope to your pay-as-you-go subscription. Name the budget `bc-budget` and make it **Monthly**, amount **$5**.
3. Add an **alert at 80%** (Actual) to your email, then **Create**.

## Part D: add the 100 demo customers

These are display only (see `scripts/tenant/seed-customers.ps1`):

- **Addresses:** `@example.com`, a domain reserved for documentation, so no email can reach anyone.
- **Phone numbers:** `555-0100` to `555-0199`, the range reserved for fiction.
- **Passwords:** random, never shown or saved.
- **They can't sign in.** Real sign-in is tested with your own addresses (Part F).

In your own VS Code terminal (Windows PowerShell), from the repo folder:

```powershell
Import-Module Microsoft.Graph.Authentication
.\scripts\tenant\seed-customers.ps1 -TenantId <customer-tenant-id> -WhatIf
```

- **Signing in:** a sign-in window opens. Use the same admin account. If asked to "sign in to all apps", choose **No, this app only**. If asked to consent to the permission, accept it: it's for this directory only.
- **What you should see:** `directory Burn and Churn Customers (customer directory)`, `existing 0`, and a "What if" line per customer.

Then run it for real:

```powershell
.\scripts\tenant\seed-customers.ps1 -TenantId <customer-tenant-id>
```

Expected: `added 100 demo customers`. Running it again adds nothing.

**Safety:** the script refuses to run unless Graph reports a customer directory (`tenantType` = `CIAM`). It also refuses the staff tenant's ID (from the hub's `.env`), so it can't add these people to the staff tenant by mistake.

**Removing them** at the end of the project: `.\scripts\tenant\remove-customers.ps1 -TenantId <customer-tenant-id>`. It deletes only accounts tagged as demo customers with `@example.com` addresses. Your own test accounts are never touched.

## Part E: one screenshot (the only evidence needed for the directory)

In the customer directory, go to **Entra ID** → **Users**. Screenshot the list showing the demo customers. Save it to `burn-and-churn-design\originals` as usual. If any row shows your own address, it'll be boxed out on the repo copy.

## Part F: later (the next PR)

Claude prepares a script for the website's customer app registration (`bc-website-customers`) and the email one-time-code sign-in. Then you sign up through the site with your two personal addresses. Those addresses only ever exist in the directory: never in the repo, a script or chat. Any screenshot that shows them is boxed out.

## After Part B

Tell Claude the directory exists. It's a new system for the program, so it gets recorded in the hub: CR-002's log, `systems.csv`, and the Microsoft vendor scope (V-003). It's recorded with no IDs.

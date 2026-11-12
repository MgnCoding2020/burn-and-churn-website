# ADR-0041: Create the customer directory by script

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

Plan §4.2 gives customers their own directory (Entra External ID), separate from the staff tenant. The first runbook (PR #54) created it by hand in the Entra admin center. The Owner asked for a script instead, like the staff app and SharePoint set-up, so the build is repeatable and reviewable.

Microsoft Graph can't create a directory. Creation is an Azure Resource Manager operation on the resource type `Microsoft.AzureActiveDirectory/ciamDirectories`, API version `2023-05-17-preview`, the only version published ([template reference](https://learn.microsoft.com/en-us/azure/templates/microsoft.azureactivedirectory/ciamdirectories), checked 2026-11-12). Its required fields are a name of 1 to 26 letters or digits (the `<name>.onmicrosoft.com` domain), a data location (`United States`), `createTenantProperties` (display name and country code `US`), and a SKU (`Standard`, tier `A0`). Budgets are `Microsoft.Consumption/budgets`, and at subscription scope each alert needs at least one email address or action group ([REST reference](https://learn.microsoft.com/en-us/rest/api/consumption/budgets/create-or-update), checked 2026-11-12).

## Decision

- **`scripts/tenant/setup-customer-directory.ps1`** registers the resource provider if needed and creates resource group `rg-bc-customers`. It then creates the directory "Burn and Churn Customers", waits for it (up to 30 minutes), and adds budget `bc-budget`: $5 a month, with alerts at 80% and 100% of actual cost.
- **One new tool on the Owner's PC:** Microsoft's `Az.Accounts` PowerShell module, for `Connect-AzAccount` and `Invoke-AzRestMethod`. No other Az modules are needed, and nothing is added to the website's dependencies.
- **No identifiers in the repository.** The subscription ID, domain prefix and alert email are typed when the script runs. The tenant ID is shown on screen once, for the Owner's password manager.
- **Safe by default:**
  - `-WhatIf` reads and lists what it would do, without writing anything.
  - Re-running the script picks up a directory that is still being created.
  - It refuses to create a second customer directory in the subscription.
  - It leaves an existing budget unchanged.
- **The preview API version is accepted.** It's the only one Microsoft publishes for this resource type. If it changes, only the version string in the script changes.
- **No removal script for the directory.** Deleting a directory means first removing its users and app registrations, and Microsoft enforces that in Entra, not in Resource Manager. `remove-customers.ps1` removes the demo customers. Deleting the directory itself is a documented manual step at the end of the project.

## Consequences

- The directory is created the same way as the rest of the tenant set-up: by a reviewed script the Owner runs in their own terminal.
- The script was tested on 2026-11-12 against a stand-in for Resource Manager: a dry run, creation and waiting, a re-run, and refusing a second directory. The first real run is the Owner's, and its result is recorded in the hub (CR-002).

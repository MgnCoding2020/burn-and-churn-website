<#
.SYNOPSIS
    Creates the Burn and Churn customer directory (Entra External ID) on the pay-as-you-go Azure
    subscription, with its resource group and a $5 monthly budget alert.

.DESCRIPTION
    Phase 5 (plan section 4.2; docs/runbooks/customer-directory.md; ADR-0041). Replaces the portal
    clicks of runbook Parts A-C. Works through Azure Resource Manager, so it needs the Az.Accounts
    module (Microsoft Graph can't create a directory).

      1. Checks the subscription is enabled.
      2. Registers the Microsoft.AzureActiveDirectory resource provider, if it isn't yet.
      3. Creates resource group rg-bc-customers (East US), if it isn't there.
      4. Creates the directory "Burn and Churn Customers" (data in the United States, country US)
         as a Microsoft.AzureActiveDirectory/ciamDirectories resource, then waits for it. Creation
         can take up to 30 minutes; if the wait runs out, run the script again: it picks up the
         directory already being created instead of starting another.
      5. Creates budget bc-budget on the subscription: $5 a month, alerts at 80% and 100% of actual
         cost to -AlertEmail and the subscription's Owners. An existing bc-budget is left alone.

    Safety: refuses to create a second customer directory if the subscription already has one
    under another name. Nothing is written to disk. The domain prefix, alert address and tenant ID
    are typed or shown on this screen only; keep them out of the repository and out of chat.
    -WhatIf signs in, reads, and lists what it would do.

    The account that runs it becomes the new directory's Global Administrator, so it can run
    seed-customers.ps1 straight after.

.PARAMETER SubscriptionId
    The pay-as-you-go subscription's ID (portal.azure.com, Subscriptions).

.PARAMETER DomainPrefix
    1-26 letters or digits. The directory's address becomes <prefix>.onmicrosoft.com and can't be
    changed later.

.PARAMETER AlertEmail
    Where the budget alerts go. Used in the request only.

.PARAMETER SignInTenant
    The staff tenant's domain (<name>.onmicrosoft.com) or ID, to sign in to. Not needed if
    Connect-AzAccount already signed in to this subscription in this terminal.

.EXAMPLE
    .\scripts\tenant\setup-customer-directory.ps1 -SubscriptionId <id> -DomainPrefix <prefix> -AlertEmail <you@...> -WhatIf
.EXAMPLE
    .\scripts\tenant\setup-customer-directory.ps1 -SubscriptionId <id> -DomainPrefix <prefix> -AlertEmail <you@...>
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')][string]$SubscriptionId,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9]{1,26}$')][string]$DomainPrefix,
    [Parameter(Mandatory)][ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')][string]$AlertEmail,
    [string]$SignInTenant,
    [int]$WaitMinutes = 40
)

$ErrorActionPreference = 'Stop'
$DisplayName   = 'Burn and Churn Customers'
$ResourceGroup = 'rg-bc-customers'
$RgLocation    = 'eastus'
$DataLocation  = 'United States'
$CountryCode   = 'US'
$BudgetName    = 'bc-budget'
$BudgetAmount  = 5
$CiamApi       = '2023-05-17-preview'
$Name          = $DomainPrefix.ToLowerInvariant()
$Sub           = "/subscriptions/$SubscriptionId"
$DirPath       = "$Sub/resourceGroups/$ResourceGroup/providers/Microsoft.AzureActiveDirectory/ciamDirectories/$Name"

# Reads and writes through Resource Manager. Invoke-AzRestMethod doesn't throw on an HTTP error, so
# check the status here. $WhatIfPreference is cleared locally: reads must still run under -WhatIf;
# writes are only ever sent from inside a ShouldProcess block.
function Invoke-Arm([string]$Method, [string]$Path, $Body, [switch]$AllowNotFound) {
    $WhatIfPreference = $false
    $p = @{ Method = $Method; Path = $Path }
    if ($null -ne $Body) { $p.Payload = ($Body | ConvertTo-Json -Depth 8) }
    $r = Invoke-AzRestMethod @p
    if ($AllowNotFound -and $r.StatusCode -eq 404) { return $null }
    if ($r.StatusCode -ge 400) {
        $msg = try { ($r.Content | ConvertFrom-Json).error.message } catch { $r.Content }
        throw "$Method $($Path -replace '\?.*$', '') failed ($($r.StatusCode)): $msg"
    }
    if ($r.Content) { $r.Content | ConvertFrom-Json } else { [pscustomobject]@{} }
}

if ($MyInvocation.InvocationName -eq '.') { return }

# ---------------------------------------------------------------- connect

$mode = if ($WhatIfPreference) { 'WHAT IF: nothing is changed' } else { 'changes are made' }
Write-Host "Customer directory ($mode)"
# Reuse a sign-in already on this subscription. Otherwise sign in to the named tenant: without one,
# Windows can offer the personal Microsoft account page, where a work account "doesn't exist".
$ctx = Get-AzContext
if (-not $ctx -or $ctx.Subscription.Id -ne $SubscriptionId) {
    if (-not $SignInTenant) { throw 'Sign in first: Connect-AzAccount -Tenant <your-tenant>.onmicrosoft.com -Subscription <subscription ID>, or pass -SignInTenant.' }
    & { $WhatIfPreference = $false; Connect-AzAccount -Tenant $SignInTenant -Subscription $SubscriptionId | Out-Null }
}

$s = Invoke-Arm GET "$Sub`?api-version=2022-12-01"
if ($s.state -ne 'Enabled') { throw "Subscription '$($s.displayName)' is $($s.state), not Enabled. Nothing was changed." }
Write-Host "  subscription  $($s.displayName)"

# ---------------------------------------------------------------- 1. resource provider

$prov = Invoke-Arm GET "$Sub/providers/Microsoft.AzureActiveDirectory?api-version=2021-04-01"
Write-Host "  provider      Microsoft.AzureActiveDirectory: $($prov.registrationState)"
if ($prov.registrationState -ne 'Registered') {
    if ($PSCmdlet.ShouldProcess('Microsoft.AzureActiveDirectory', 'Register resource provider')) {
        Invoke-Arm POST "$Sub/providers/Microsoft.AzureActiveDirectory/register?api-version=2021-04-01" | Out-Null
        for ($i = 0; $i -lt 30 -and $prov.registrationState -ne 'Registered'; $i++) {
            Start-Sleep -Seconds 10
            $prov = Invoke-Arm GET "$Sub/providers/Microsoft.AzureActiveDirectory?api-version=2021-04-01"
        }
        if ($prov.registrationState -ne 'Registered') { throw 'The resource provider is still registering. Run the script again in a few minutes.' }
        Write-Host '                registered'
    }
}

# ---------------------------------------------------------------- 2. one customer directory only

$dir = $null
if ($prov.registrationState -eq 'Registered') {
    $all = @((Invoke-Arm GET "$Sub/providers/Microsoft.AzureActiveDirectory/ciamDirectories?api-version=$CiamApi").value)
    $other = $all | Where-Object { $_.name -ne $Name }
    if ($other) { throw "This subscription already has a customer directory ($(@($other).Count)): $(($other | ForEach-Object { $_.name }) -join ', '). Nothing was changed." }
    # The list may leave out tenantId and domainName; read the directory itself.
    if ($all | Where-Object { $_.name -eq $Name }) { $dir = Invoke-Arm GET "$DirPath`?api-version=$CiamApi" }
}

# ---------------------------------------------------------------- 3. resource group

$rg = Invoke-Arm GET "$Sub/resourcegroups/$ResourceGroup`?api-version=2021-04-01" -AllowNotFound
Write-Host "  group         $ResourceGroup$(if ($rg) { ': exists' } else { ': missing' })"
if (-not $rg -and $PSCmdlet.ShouldProcess($ResourceGroup, "Create resource group in $RgLocation")) {
    Invoke-Arm PUT "$Sub/resourcegroups/$ResourceGroup`?api-version=2021-04-01" @{ location = $RgLocation } | Out-Null
    Write-Host '                created'
}

# ---------------------------------------------------------------- 4. the directory

if ($dir) {
    Write-Host "  directory     $DisplayName ($Name): $($dir.properties.provisioningState)"
} elseif ($PSCmdlet.ShouldProcess("$DisplayName ($Name.onmicrosoft.com)", "Create customer directory, data in $DataLocation")) {
    $body = @{
        location   = $DataLocation
        sku        = @{ name = 'Standard'; tier = 'A0' }
        properties = @{ createTenantProperties = @{ displayName = $DisplayName; countryCode = $CountryCode } }
        tags       = @{ project = 'burn-and-churn'; purpose = 'customer-directory' }
    }
    Invoke-Arm PUT "$DirPath`?api-version=$CiamApi" $body | Out-Null
    Write-Host '  directory     creation started (up to 30 minutes)'
    $dir = [pscustomobject]@{ properties = [pscustomobject]@{ provisioningState = 'Creating' } }
} else {
    Write-Host "  directory     $DisplayName ($Name): missing"
}

if (-not $WhatIfPreference -and $dir) {
    $deadline = (Get-Date).AddMinutes($WaitMinutes)
    while ($dir.properties.provisioningState -notin 'Succeeded', 'Failed', 'Canceled' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 30
        $dir = Invoke-Arm GET "$DirPath`?api-version=$CiamApi" -AllowNotFound
        if (-not $dir) { $dir = [pscustomobject]@{ properties = [pscustomobject]@{ provisioningState = 'Creating' } } }
        Write-Host "                $(Get-Date -Format HH:mm) $($dir.properties.provisioningState)"
    }
    switch ($dir.properties.provisioningState) {
        'Succeeded' { }
        { $_ -in 'Failed', 'Canceled' } { throw "Directory creation ended: $_. Check the resource group in the Azure portal." }
        default { throw "Still creating after $WaitMinutes minutes. Run the script again later; it will wait for this same directory." }
    }
}

# ---------------------------------------------------------------- 5. budget

$budgetPath = "$Sub/providers/Microsoft.Consumption/budgets/$BudgetName`?api-version=2024-08-01"
$budget = Invoke-Arm GET $budgetPath -AllowNotFound
Write-Host "  budget        $BudgetName$(if ($budget) { ": exists ($($budget.properties.amount) a month), left as it is" } else { ': missing' })"
if (-not $budget -and $PSCmdlet.ShouldProcess($BudgetName, "Create `$$BudgetAmount monthly budget, alerts at 80% and 100%")) {
    $start = (Get-Date).ToUniversalTime()
    $alert = { param($pct) @{ enabled = $true; operator = 'GreaterThan'; threshold = $pct; thresholdType = 'Actual'; contactEmails = @($AlertEmail); contactRoles = @('Owner'); locale = 'en-us' } }
    $body = @{
        properties = @{
            category      = 'Cost'
            amount        = $BudgetAmount
            timeGrain     = 'Monthly'
            timePeriod    = @{ startDate = ('{0:D4}-{1:D2}-01T00:00:00Z' -f $start.Year, $start.Month) }
            notifications = @{
                Actual_GreaterThan_80_Percent  = (& $alert 80)
                Actual_GreaterThan_100_Percent = (& $alert 100)
            }
        }
    }
    Invoke-Arm PUT $budgetPath $body | Out-Null
    Write-Host '                created'
}

# ---------------------------------------------------------------- next step

if ($WhatIfPreference) { Write-Host 'Done (what if). Run again without -WhatIf to make the changes.'; return }

Write-Host ''
Write-Host "Done. $DisplayName is ready."
Write-Host "  domain     $($dir.properties.domainName)"
Write-Host "  tenant ID  $($dir.properties.tenantId)"
if (-not $dir.properties.tenantId) { Write-Host '  (tenant ID not returned: find it under Entra ID, Overview, Manage tenants)' }
Write-Host 'Copy the tenant ID into your password manager notes (not chat, not the repo). Next:'
Write-Host '  .\scripts\tenant\seed-customers.ps1 -TenantId <tenant ID> -WhatIf'

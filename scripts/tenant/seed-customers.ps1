<#
.SYNOPSIS
    Adds 100 fictional customers to the Burn and Churn customer directory (Entra External ID),
    so the directory looks like a real cafe's. They can't sign in: their addresses don't exist.

.DESCRIPTION
    Phase 5 (plan section 4.2; docs/runbooks/customer-directory.md). Display only: real sign-in is
    tested with the Owner's own test addresses through the site's sign-up page, never here.

      - Names are made-up combinations from two short lists.
      - Email addresses use example.com, a domain reserved for documentation (RFC 2606), so no
        message can ever reach a real person.
      - Phone numbers are +1 555-0100 to 555-0199, the range reserved for fiction.
      - Each account gets a long random password that is never shown, logged or saved, and
        companyName "Burn and Churn demo customer (fictional)", which is how
        remove-customers.ps1 finds them (and nothing else).

    Safety: refuses to run unless Graph reports the tenant as a customer directory (tenantType
    CIAM), and refuses the staff tenant's ID from the hub's .env. Safe to run more than once:
    existing demo customers are left alone. -WhatIf signs in read-only and lists what it would add.

.PARAMETER TenantId
    The customer directory's tenant ID. Optional: by default it's read from ENTRA_CUSTOMER_TENANT_ID
    in the git-ignored .dev.vars, where setup-customer-directory.ps1 writes it.

.EXAMPLE
    .\scripts\tenant\seed-customers.ps1 -WhatIf
.EXAMPLE
    .\scripts\tenant\seed-customers.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')][string]$TenantId,
    [string]$HubPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Tag = 'Burn and Churn demo customer (fictional)'
$Count = 100

$First = 'Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Quinn', 'Rowan', 'Harper', 'Emerson',
         'Sage', 'Parker', 'Reese', 'Dakota', 'Hayden', 'Finley', 'Blake', 'Kendall', 'Logan', 'Skyler'
$Last  = 'Bramble', 'Calder', 'Dunmore', 'Ellwood', 'Fairbank', 'Galloway', 'Hollins', 'Ivers', 'Jessop', 'Kettering',
         'Larkin', 'Merriweather', 'Northcott', 'Oakhurst', 'Pemberton', 'Quarrie', 'Redfern', 'Stroud', 'Thackeray', 'Underhill'

# Customer i (0-99): every first name once per block of 20, paired with a different surname in
# each block, so all 100 names (and addresses) are unique.
function Get-DemoCustomer([int]$i) {
    $f = $First[$i % 20]
    $l = $Last[[int]((($i % 20) + [math]::Floor($i / 20)) % 20)]
    [pscustomobject]@{
        DisplayName = "$f $l"
        GivenName   = $f
        Surname     = $l
        Email       = ("{0}.{1}@example.com" -f $f, $l).ToLowerInvariant()
        Phone       = '+1 555-01{0:D2}' -f $i
    }
}

# A password nobody will ever see: 32 characters from every class, from the system's
# cryptographic random generator. Used once in the request body, then discarded.
function New-UnusedPassword {
    $sets = 'ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+'
    $all = -join $sets
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $chars = for ($k = 0; $k -lt 32; $k++) {
        $set = if ($k -lt 4) { $sets[$k] } else { $all }
        $set[$bytes[$k] % $set.Length]
    }
    -join $chars
}

# The customer directory's ID from the git-ignored .dev.vars (written there by
# setup-customer-directory.ps1), when -TenantId isn't given.
function Get-CustomerTenantId([string]$Root) {
    $f = Join-Path $Root '.dev.vars'
    if (Test-Path $f) {
        $line = Get-Content $f | Where-Object { $_ -match '^\s*ENTRA_CUSTOMER_TENANT_ID\s*=' } | Select-Object -First 1
        if ($line) { return ($line -replace '^[^=]*=\s*', '' -replace '["'']', '').Trim() }
    }
    $null
}

if ($MyInvocation.InvocationName -eq '.') { return }

if (-not $TenantId) {
    $fromFile = Get-CustomerTenantId $RepoRoot
    if ($fromFile -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw 'No customer tenant ID: pass -TenantId, or set ENTRA_CUSTOMER_TENANT_ID in .dev.vars (setup-customer-directory.ps1 does this).' }
    $TenantId = $fromFile
}
if ($TenantId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw 'No customer tenant ID: pass -TenantId, or set ENTRA_CUSTOMER_TENANT_ID in .dev.vars (setup-customer-directory.ps1 does this).' }

# ---------------------------------------------------------------- guard: not the staff tenant

if (-not $HubPath) { $HubPath = Join-Path (Split-Path $RepoRoot -Parent) 'grc-paper-project-coffee-shop' }
$hubEnv = Join-Path $HubPath '.env'
if (Test-Path $hubEnv) {
    $staffTenant = (Get-Content $hubEnv | Where-Object { $_ -match '^\s*ENTRA_TENANT_ID\s*=' } | Select-Object -First 1) -replace '^[^=]*=\s*', '' -replace '["'']', ''
    if ($staffTenant -and $staffTenant.Trim() -eq $TenantId) { throw 'That is the staff tenant (hub .env ENTRA_TENANT_ID). Use the customer directory''s tenant ID.' }
}

# ---------------------------------------------------------------- connect

# Az.Accounts and Microsoft.Graph.Authentication ship different versions of the same libraries;
# with Az loaded first, Graph calls fail with "Method not found" (seen 2026-11-12).
if (Get-Module Az.Accounts) { throw 'Az.Accounts is loaded in this terminal (from setup-customer-directory.ps1), which breaks Microsoft Graph. Open a new terminal and run this script there.' }

$mode = if ($WhatIfPreference) { 'WHAT IF: nothing is changed' } else { 'changes are made' }
Write-Host "Demo customers ($mode)"
$scopes = if ($WhatIfPreference) { 'User.Read.All' } else { 'User.ReadWrite.All' }
Connect-MgGraph -TenantId $TenantId -Scopes $scopes -NoWelcome

$org = (Invoke-MgGraphRequest -Method GET -Uri 'v1.0/organization?$select=id,displayName,tenantType,verifiedDomains').value | Select-Object -First 1
if ($org.tenantType -ne 'CIAM') { throw "This tenant's type is '$($org.tenantType)', not a customer directory (CIAM). Nothing was changed." }
$issuer = (@($org.verifiedDomains) | Where-Object { $_.isInitial } | Select-Object -First 1).name
if (-not $issuer) { throw 'Could not find the directory''s initial domain.' }
Write-Host "  directory  $($org.displayName) (customer directory)"

# ---------------------------------------------------------------- who's already there

$existing = @{}
$uri = "v1.0/users?`$filter=companyName eq '$Tag'&`$count=true&`$select=id,mail&`$top=999"
while ($uri) {
    $page = Invoke-MgGraphRequest -Method GET -Uri $uri -Headers @{ ConsistencyLevel = 'eventual' }
    foreach ($u in @($page.value)) { if ($u.mail) { $existing[$u.mail.ToLowerInvariant()] = $true } }
    $uri = $page.'@odata.nextLink'
}
Write-Host "  existing   $($existing.Count) demo customers"

# ---------------------------------------------------------------- add the missing ones

$added = 0
for ($i = 0; $i -lt $Count; $i++) {
    $c = Get-DemoCustomer $i
    if ($existing.ContainsKey($c.Email)) { continue }
    if ($PSCmdlet.ShouldProcess($c.DisplayName, "Add demo customer $($c.Email)")) {
        $body = @{
            displayName      = $c.DisplayName
            givenName        = $c.GivenName
            surname          = $c.Surname
            mail             = $c.Email
            mobilePhone      = $c.Phone
            companyName      = $Tag
            identities       = @(@{ signInType = 'emailAddress'; issuer = $issuer; issuerAssignedId = $c.Email })
            passwordProfile  = @{ password = (New-UnusedPassword); forceChangePasswordNextSignIn = $false }
            passwordPolicies = 'DisablePasswordExpiration'
        }
        Invoke-MgGraphRequest -Method POST -Uri 'v1.0/users' -Body ($body | ConvertTo-Json -Depth 5) -ContentType 'application/json' | Out-Null
        $body = $null
        $added++
    }
}

$verb = if ($WhatIfPreference) { 'would add' } else { 'added' }
Write-Host "  $verb  $(if ($WhatIfPreference) { $Count - $existing.Count } else { $added }) demo customers"
Write-Host 'Done. Remove them with: .\scripts\tenant\remove-customers.ps1'

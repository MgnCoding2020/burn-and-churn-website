<#
.SYNOPSIS
    Exports the trial's tenant evidence (sign-in logs, Conditional Access, audit, roles, licences)
    into the repo, with the real tenant domain swapped for the fictional one and IP addresses removed.

.DESCRIPTION
    Phase 7 (plan sections 3.4, 3.5; trial test plan T-END-01). Read-only: it changes nothing in
    the tenant. One run replaces most of the trial's screenshots. Run it during week 3 (after
    Conditional Access is On), and again before day 30.

      signins.csv            Sign-ins to bc-website-staff: time, user, result, the Conditional
                             Access policies applied and their result, MFA, client, device
                             compliance. No IP address or location.
      conditional-access.json  Every "BC - " policy as configured (state, users, apps, controls).
      conditional-access-summary.csv  All policies in the tenant: name and state only.
      directory-audit.csv    Entra audit events for the website's apps and the BC policies.
      staff-app-roles.csv    Who holds which app role on bc-website-staff (groups after -ByGroup).
      licences.csv           The tenant's subscriptions: SKU, enabled and used seats.
      README.md              What was exported, when, and the counts.

    Privacy: the real tenant domain is replaced with the hub's fictional BC_DOC_DOMAIN everywhere,
    the tenant ID with <tenant>, and IP addresses and locations are never written. Review the files
    before committing them. Purview audit searches are exported from the Purview portal (T-AUD-01).

    -WhatIf signs in, reads, and prints the counts without writing any file.

.PARAMETER Days
    How many days of sign-ins and audit events to export (default 30, the trial's length).

.PARAMETER OutDir
    Where to write. Default: docs/evidence/<today>-tenant-export in this repo.

.EXAMPLE
    .\scripts\tenant\export-evidence.ps1 -WhatIf
.EXAMPLE
    .\scripts\tenant\export-evidence.ps1 -Days 14
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateRange(1, 30)][int]$Days = 30,
    [string]$OutDir,
    [string]$HubPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Apps = @('bc-website-staff', 'bc-website-sync')

# ---------------------------------------------------------------- helpers (no Graph calls)

function Read-DotEnv([string]$Path) {
    if (-not (Test-Path $Path)) { throw "Missing $Path. The hub's .env holds the tenant values." }
    $values = @{}
    foreach ($line in Get-Content $Path) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2].Trim('"', "'") }
    }
    foreach ($key in 'ENTRA_TENANT_ID', 'ENTRA_TENANT_DOMAIN', 'BC_DOC_DOMAIN') {
        if (-not $values[$key]) { throw "$key is not set in $Path." }
    }
    return $values
}

# The real tenant never reaches a file: its domain becomes the fictional one, its ID <tenant>.
function Protect-Text([string]$Text, [string]$RealDomain, [string]$DocDomain, [string]$TenantId) {
    if (-not $Text) { return $Text }
    $t = $Text -replace [regex]::Escape($RealDomain), $DocDomain
    return ($t -replace [regex]::Escape($TenantId), '<tenant>')
}

# One row per sign-in, without the IP address or location.
function ConvertTo-SignInRow($s) {
    [pscustomobject]@{
        time                  = $s.createdDateTime
        user                  = $s.userPrincipalName
        app                   = $s.appDisplayName
        result                = if ($s.status.errorCode -eq 0) { 'success' } else { "failure $($s.status.errorCode)" }
        failureReason         = $s.status.failureReason
        conditionalAccess     = $s.conditionalAccessStatus
        policiesApplied       = (@($s.appliedConditionalAccessPolicies) | Where-Object { $_.result -ne 'notEnabled' } | ForEach-Object { "$($_.displayName): $($_.result)" }) -join '; '
        authRequirement       = $s.authenticationRequirement
        client                = $s.clientAppUsed
        os                    = $s.deviceDetail.operatingSystem
        browser               = $s.deviceDetail.browser
        deviceCompliant       = $s.deviceDetail.isCompliant
    }
}

# Dot-sourcing (tests) loads the helpers above and stops here
if ($MyInvocation.InvocationName -eq '.') { return }

# ---------------------------------------------------------------- inputs

if (Get-Module Az.Accounts) { throw 'Az.Accounts is loaded in this terminal, which breaks Microsoft Graph. Open a new terminal and run this script there.' }
if (-not $HubPath) { $HubPath = Join-Path (Split-Path $RepoRoot -Parent) 'grc-paper-project-coffee-shop' }
$envValues  = Read-DotEnv (Join-Path $HubPath '.env')
$tenantId   = $envValues['ENTRA_TENANT_ID']
$realDomain = $envValues['ENTRA_TENANT_DOMAIN']
$docDomain  = $envValues['BC_DOC_DOMAIN']
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot ("docs\evidence\{0:yyyy-MM-dd}-tenant-export" -f (Get-Date)) }
$since = (Get-Date).ToUniversalTime().AddDays(-$Days).ToString('yyyy-MM-ddTHH:mm:ssZ')
$mode = if ($WhatIfPreference) { 'WHAT IF: nothing is written' } else { "writing to $OutDir" }
Write-Host "Tenant evidence export, last $Days days ($mode)"

Connect-MgGraph -TenantId $tenantId -Scopes 'AuditLog.Read.All', 'Policy.Read.All', 'Application.Read.All', 'Directory.Read.All' -NoWelcome

function Get-All([string]$Uri) {
    $items = @()
    while ($Uri) {
        $page = Invoke-MgGraphRequest -Method GET -Uri $Uri -OutputType PSObject
        $items += @($page.value)
        $Uri = $page.'@odata.nextLink'
    }
    return $items
}
function Protect([string]$t) { Protect-Text $t $realDomain $docDomain $tenantId }

# ---------------------------------------------------------------- read

$signIns = @(Get-All "v1.0/auditLogs/signIns?`$filter=appDisplayName eq 'bc-website-staff' and createdDateTime ge $since&`$top=500") |
    ForEach-Object { ConvertTo-SignInRow $_ }
Write-Host ("  sign-ins       {0}" -f $signIns.Count)

$policies = @(Get-All 'v1.0/identity/conditionalAccess/policies')
$bcPolicies = @($policies | Where-Object { $_.displayName -like 'BC - *' })
Write-Host ("  CA policies    {0} in the tenant, {1} BC" -f $policies.Count, $bcPolicies.Count)

$watched = $Apps + @($bcPolicies | ForEach-Object { $_.displayName })
$audit = @(Get-All "v1.0/auditLogs/directoryAudits?`$filter=activityDateTime ge $since&`$top=500") |
    Where-Object { @($_.targetResources | Where-Object { $watched -contains $_.displayName }).Count } |
    ForEach-Object {
        [pscustomobject]@{
            time      = $_.activityDateTime
            activity  = $_.activityDisplayName
            category  = $_.category
            result    = $_.result
            by        = if ($_.initiatedBy.user) { $_.initiatedBy.user.userPrincipalName } else { $_.initiatedBy.app.displayName }
            targets   = (@($_.targetResources) | ForEach-Object { $_.displayName } | Where-Object { $_ }) -join '; '
        }
    }
Write-Host ("  audit events   {0}" -f @($audit).Count)

$roles = @()
$sp = @(Get-All "v1.0/servicePrincipals?`$filter=displayName eq 'bc-website-staff'") | Select-Object -First 1
if ($sp) {
    $roleNames = @{}
    foreach ($r in @($sp.appRoles)) { $roleNames[[string]$r.id] = $r.value }
    $roles = @(Get-All "v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo?`$top=999") | ForEach-Object {
        [pscustomobject]@{ principal = $_.principalDisplayName; type = $_.principalType; role = $roleNames[[string]$_.appRoleId] }
    } | Sort-Object type, role, principal
}
Write-Host ("  role holders   {0}" -f @($roles).Count)

$licences = @(Get-All 'v1.0/subscribedSkus') | ForEach-Object {
    [pscustomobject]@{ sku = $_.skuPartNumber; status = $_.capabilityStatus; enabled = $_.prepaidUnits.enabled; used = $_.consumedUnits }
}
Write-Host ("  subscriptions  {0}" -f @($licences).Count)

# ---------------------------------------------------------------- write

if ($WhatIfPreference) { Write-Host 'Done (what if): nothing written.'; Disconnect-MgGraph | Out-Null; return }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false
function Save([string]$Name, [string]$Text) { [IO.File]::WriteAllText((Join-Path $OutDir $Name), (Protect $Text), $utf8) }

Save 'signins.csv' (($signIns | ConvertTo-Csv -NoTypeInformation) -join "`n")
Save 'conditional-access.json' (($bcPolicies | Select-Object displayName, state, createdDateTime, modifiedDateTime, conditions, grantControls, sessionControls) | ConvertTo-Json -Depth 12)
Save 'conditional-access-summary.csv' ((($policies | ForEach-Object { [pscustomobject]@{ policy = $_.displayName; state = $_.state } }) | ConvertTo-Csv -NoTypeInformation) -join "`n")
Save 'directory-audit.csv' (($audit | ConvertTo-Csv -NoTypeInformation) -join "`n")
Save 'staff-app-roles.csv' (($roles | ConvertTo-Csv -NoTypeInformation) -join "`n")
Save 'licences.csv' (($licences | ConvertTo-Csv -NoTypeInformation) -join "`n")
Save 'README.md' (@"
# Tenant evidence export ($(Get-Date -Format 'yyyy-MM-dd'))

Exported by ``scripts/tenant/export-evidence.ps1`` (read-only), covering the last $Days days. The real tenant domain is replaced with the fictional one and the tenant ID with ``<tenant>``; IP addresses and locations aren't exported.

| File | Rows |
| --- | --- |
| ``signins.csv`` | $($signIns.Count) sign-ins to bc-website-staff |
| ``conditional-access.json`` | $($bcPolicies.Count) BC policies |
| ``conditional-access-summary.csv`` | $($policies.Count) policies in the tenant |
| ``directory-audit.csv`` | $(@($audit).Count) audit events for the website's apps and the BC policies |
| ``staff-app-roles.csv`` | $(@($roles).Count) role holders on bc-website-staff |
| ``licences.csv`` | $(@($licences).Count) subscriptions |

Reviewed by Michael before commit: [ ]
"@)

# A last check: the real domain and tenant ID must not be in anything written.
$leak = Get-ChildItem $OutDir -File | Where-Object { (Get-Content $_.FullName -Raw) -match ([regex]::Escape($realDomain) + '|' + [regex]::Escape($tenantId)) }
if ($leak) { throw "The real domain or tenant ID is still in: $($leak.Name -join ', '). Don't commit these files." }

Write-Host "Done. Files in $OutDir. Review them, then commit."
Disconnect-MgGraph | Out-Null

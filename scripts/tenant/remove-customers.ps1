<#
.SYNOPSIS
    Removes the fictional demo customers that seed-customers.ps1 added to the customer directory.

.DESCRIPTION
    Deletes only accounts whose companyName is "Burn and Churn demo customer (fictional)" AND whose
    email address ends in @example.com. Real test accounts (the Owner's own sign-ups) are never
    touched. Deleted accounts sit in the directory's recycle bin for 30 days. Same tenant checks as
    seed-customers.ps1. -WhatIf lists what would go.

.EXAMPLE
    .\scripts\tenant\remove-customers.ps1 -WhatIf   (tenant ID from .dev.vars, or pass -TenantId)
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [ValidatePattern('^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')][string]$TenantId
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

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

if (-not $TenantId) {
    $fromFile = Get-CustomerTenantId $RepoRoot
    if ($fromFile -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw 'No customer tenant ID: pass -TenantId, or set ENTRA_CUSTOMER_TENANT_ID in .dev.vars (setup-customer-directory.ps1 does this).' }
    $TenantId = $fromFile
}
if ($TenantId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw 'No customer tenant ID: pass -TenantId, or set ENTRA_CUSTOMER_TENANT_ID in .dev.vars (setup-customer-directory.ps1 does this).' }

$Tag = 'Burn and Churn demo customer (fictional)'

$scopes = if ($WhatIfPreference) { 'User.Read.All' } else { 'User.ReadWrite.All' }
Connect-MgGraph -TenantId $TenantId -Scopes $scopes -NoWelcome
$org = (Invoke-MgGraphRequest -Method GET -Uri 'v1.0/organization?$select=displayName,tenantType').value | Select-Object -First 1
if ($org.tenantType -ne 'CIAM') { throw "This tenant's type is '$($org.tenantType)', not a customer directory (CIAM). Nothing was changed." }

$demo = @()
$uri = "v1.0/users?`$filter=companyName eq '$Tag'&`$count=true&`$select=id,displayName,mail&`$top=999"
while ($uri) {
    $page = Invoke-MgGraphRequest -Method GET -Uri $uri -Headers @{ ConsistencyLevel = 'eventual' }
    $demo += @($page.value) | Where-Object { $_.mail -and $_.mail.ToLowerInvariant().EndsWith('@example.com') }
    $uri = $page.'@odata.nextLink'
}
Write-Host "Demo customers in $($org.displayName): $($demo.Count)"
if ($demo.Count -eq 0) { return }

if ($PSCmdlet.ShouldProcess("$($demo.Count) demo customers", 'Delete')) {
    foreach ($u in $demo) { Invoke-MgGraphRequest -Method DELETE -Uri "v1.0/users/$($u.id)" | Out-Null }
    Write-Host "  deleted  $($demo.Count) (in the recycle bin for 30 days)"
}

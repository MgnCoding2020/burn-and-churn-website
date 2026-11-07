<#
.SYNOPSIS
    Removes the Entra ID app "bc-website-staff": every role assignment, the enterprise app and
    the app registration. The reverse of setup-staff-app.ps1 (plan section 3.3).

.DESCRIPTION
    Staff can no longer sign in to the website afterwards. Users and groups are untouched
    (they belong to the hub). Entra keeps a deleted app for 30 days under
    App registrations > Deleted applications, where it can be restored.

    Asks before deleting unless -Confirm:$false is given. -WhatIf shows what would go.
    The certificate files in your secrets folder and the values in .dev.vars are left for you
    to delete by hand.

.EXAMPLE
    .\scripts\tenant\remove-staff-app.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$HubPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AppName = 'bc-website-staff'
if (-not $HubPath) { $HubPath = Join-Path (Split-Path $RepoRoot -Parent) 'grc-paper-project-coffee-shop' }

$envFile = Join-Path $HubPath '.env'
if (-not (Test-Path $envFile)) { throw "Missing $envFile (the tenant ID is read from the hub's .env)." }
$tenantId = (Get-Content $envFile | Where-Object { $_ -match '^\s*ENTRA_TENANT_ID\s*=\s*(\S+)' } | ForEach-Object { $Matches[1] } | Select-Object -First 1)
if (-not $tenantId) { throw "ENTRA_TENANT_ID is not set in $envFile." }

$scopes = if ($WhatIfPreference) { 'Directory.Read.All' } else { 'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All' }
Connect-MgGraph -TenantId $tenantId -Scopes $scopes -NoWelcome

$app = @((Invoke-MgGraphRequest -Method GET -Uri "v1.0/applications?`$filter=displayName eq '$AppName'").value)
if ($app.Count -ne 1) {
    Write-Host "Found $($app.Count) apps named ${AppName}: nothing to remove (or remove the extras by hand)."
    Disconnect-MgGraph | Out-Null
    return
}
$app = $app[0]
$sp = @((Invoke-MgGraphRequest -Method GET -Uri "v1.0/servicePrincipals?`$filter=appId eq '$($app.appId)'").value) | Select-Object -First 1

if ($sp) {
    $assignments = @((Invoke-MgGraphRequest -Method GET -Uri "v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo").value)
    Write-Host "$AppName has $($assignments.Count) role assignments."
    foreach ($a in $assignments) {
        if ($PSCmdlet.ShouldProcess($a.principalDisplayName, 'Remove role assignment')) {
            Invoke-MgGraphRequest -Method DELETE -Uri "v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo/$($a.id)" | Out-Null
            Write-Host "  removed assignment: $($a.principalDisplayName)"
        }
    }
    if ($PSCmdlet.ShouldProcess("$AppName (enterprise app)", 'Delete')) {
        Invoke-MgGraphRequest -Method DELETE -Uri "v1.0/servicePrincipals/$($sp.id)" | Out-Null
        Write-Host "  deleted enterprise app"
    }
}
if ($PSCmdlet.ShouldProcess("$AppName (app registration)", 'Delete (restorable for 30 days)')) {
    Invoke-MgGraphRequest -Method DELETE -Uri "v1.0/applications/$($app.id)" | Out-Null
    Write-Host "  deleted app registration (restorable for 30 days)"
}
Disconnect-MgGraph | Out-Null

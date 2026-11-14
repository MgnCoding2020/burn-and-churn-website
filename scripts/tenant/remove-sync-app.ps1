<#
.SYNOPSIS
    Removes the Entra ID app "bc-website-sync": its role assignments (the Graph permission's
    consent), the enterprise app and the app registration. The reverse of setup-sync-app.ps1
    (plan section 3.3), for the end of the trial.

.DESCRIPTION
    The website stops syncing from SharePoint afterwards and keeps showing its last published
    copy (ADR-0045). The per-list read grants on the SharePoint lists stop working with the app;
    the site and lists themselves are deleted in the SharePoint admin centre, or by Microsoft when
    the trial lapses. Entra keeps a deleted app for 30 days under App registrations > Deleted
    applications, where it can be restored.

    Asks before deleting unless -Confirm:$false is given. -WhatIf shows what would go.
    The certificate files in your secrets folder, the GRAPH_ and SHAREPOINT_ values in .dev.vars
    and the production Worker secrets are left for you to delete by hand.

.EXAMPLE
    .\scripts\tenant\remove-sync-app.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$HubPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AppName = 'bc-website-sync'
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
    # The app's own Graph permission (Lists.SelectedOperations.Selected) is an assignment held BY it.
    $assignments = @((Invoke-MgGraphRequest -Method GET -Uri "v1.0/servicePrincipals/$($sp.id)/appRoleAssignments").value)
    Write-Host "$AppName holds $($assignments.Count) application permission(s)."
    foreach ($a in $assignments) {
        if ($PSCmdlet.ShouldProcess("$($a.resourceDisplayName) permission", 'Remove consent')) {
            Invoke-MgGraphRequest -Method DELETE -Uri "v1.0/servicePrincipals/$($sp.id)/appRoleAssignments/$($a.id)" | Out-Null
            Write-Host "  removed consent: $($a.resourceDisplayName)"
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

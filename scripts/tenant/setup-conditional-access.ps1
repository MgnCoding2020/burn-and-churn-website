<#
.SYNOPSIS
    Creates the Burn and Churn Conditional Access policies (report-only first) and lists every
    other policy already in the tenant.

.DESCRIPTION
    Trial (plan §4.1; docs/tenant-setup.md step 6; trial tests T-CA-*). Needs Entra ID P1,
    which the Business Premium trial brings. Policies are named "BC - ..." and target the
    Burn and Churn groups only, because the tenant is shared:

      BC - Staff portal - Require MFA                 bc-website-staff; grp-bc-all-staff
      BC - Block legacy authentication                all apps; grp-bc-all-staff
      BC - Staff portal - Sign-in every 8 hours        bc-website-staff; grp-bc-all-staff
      BC - Staff portal - Require compliant device    bc-website-staff; grp-bc-all-staff (Intune)

    Every policy excludes grp-bc-break-glass (plan §4.1). The device policy also excludes
    grp-bc-testers, if it exists, so an outside reviewer's own laptop isn't blocked.

    -State sets all four at once: ReportOnly (default for new ones), On, or Off. Without
    -State, existing policies keep their state and only their conditions are brought back in
    line. Other policies in the tenant (the cyber-homelab's, say) are listed, never changed;
    with P1 back, report-only ones among them start evaluating Burn and Churn users too.

    -WhatIf signs in read-only and lists every change without making it.

.PARAMETER State
    ReportOnly, On or Off for the four BC policies.

.EXAMPLE
    .\scripts\tenant\setup-conditional-access.ps1 -WhatIf
.EXAMPLE
    .\scripts\tenant\setup-conditional-access.ps1
.EXAMPLE
    .\scripts\tenant\setup-conditional-access.ps1 -State On
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('ReportOnly', 'On', 'Off')]
    [string]$State
)

$ErrorActionPreference = 'Stop'
$StaffApp = 'bc-website-staff'
$Groups = @{ staff = 'grp-bc-all-staff'; breakGlass = 'grp-bc-break-glass'; testers = 'grp-bc-testers' }
$StateValue = @{ ReportOnly = 'enabledForReportingButNotEnforced'; On = 'enabled'; Off = 'disabled' }

# The four policies, given the resolved IDs. Pure: tested by dot-sourcing.
function Get-BcPolicies([string]$AppId, [string]$StaffGroupId, [string[]]$Excluded, [string[]]$DeviceExcluded) {
    $users = @{ includeGroups = @($StaffGroupId); excludeGroups = @($Excluded) }
    $deviceUsers = @{ includeGroups = @($StaffGroupId); excludeGroups = @($DeviceExcluded) }
    $portal = @{ includeApplications = @($AppId) }
    return @(
        [ordered]@{
            displayName = 'BC - Staff portal - Require MFA'
            conditions = @{ users = $users; applications = $portal; clientAppTypes = @('all') }
            grantControls = @{ operator = 'OR'; builtInControls = @('mfa') }
        }
        [ordered]@{
            displayName = 'BC - Block legacy authentication'
            conditions = @{ users = $users; applications = @{ includeApplications = @('All') }; clientAppTypes = @('exchangeActiveSync', 'other') }
            grantControls = @{ operator = 'OR'; builtInControls = @('block') }
        }
        [ordered]@{
            displayName = 'BC - Staff portal - Sign-in every 8 hours'
            conditions = @{ users = $users; applications = $portal; clientAppTypes = @('all') }
            sessionControls = @{ signInFrequency = @{ isEnabled = $true; type = 'hours'; value = 8; frequencyInterval = 'timeBased'; authenticationType = 'primaryAndSecondaryAuthentication' } }
        }
        [ordered]@{
            displayName = 'BC - Staff portal - Require compliant device'
            conditions = @{ users = $deviceUsers; applications = $portal; clientAppTypes = @('all') }
            grantControls = @{ operator = 'OR'; builtInControls = @('compliantDevice') }
        }
    )
}

if ($MyInvocation.InvocationName -eq '.') { return }

$mode = if ($WhatIfPreference) { 'WHAT IF: nothing is changed' } else { 'changes are made' }
Write-Host "Conditional Access for Burn and Churn ($mode)"
$scopes = if ($WhatIfPreference) { 'Policy.Read.All', 'Application.Read.All', 'Group.Read.All' } else { 'Policy.ReadWrite.ConditionalAccess', 'Policy.Read.All', 'Application.Read.All', 'Group.Read.All' }
Connect-MgGraph -Scopes $scopes -NoWelcome
function Invoke-Graph([string]$Method, [string]$Uri, $Body) {
    if ($null -ne $Body) { return Invoke-MgGraphRequest -Method $Method -Uri $Uri -Body ($Body | ConvertTo-Json -Depth 10) -ContentType 'application/json' }
    return Invoke-MgGraphRequest -Method $Method -Uri $Uri
}
function Find-Group([string]$Name) { (Invoke-Graph GET "v1.0/groups?`$filter=displayName eq '$Name'&`$select=id").value | Select-Object -First 1 }

$app = (Invoke-Graph GET "v1.0/applications?`$filter=displayName eq '$StaffApp'&`$select=appId").value | Select-Object -First 1
if (-not $app) { throw "$StaffApp not found: run setup-staff-app.ps1 first." }
$staff = Find-Group $Groups.staff
if (-not $staff) { throw "$($Groups.staff) not found: run the hub's provision-users.ps1 first." }
$breakGlass = Find-Group $Groups.breakGlass
$testers = Find-Group $Groups.testers
if (-not $breakGlass) { Write-Warning "$($Groups.breakGlass) not found. Break-glass accounts must be excluded before any policy is turned On (plan §4.1)." }
if (-not $testers) { Write-Host "  note       $($Groups.testers) doesn't exist yet; the device policy has no tester exclusion (hub CR-004 guest pattern)." }
$excluded = @($breakGlass.id | Where-Object { $_ })
$deviceExcluded = @(@($breakGlass.id, $testers.id) | Where-Object { $_ })

$existing = @((Invoke-Graph GET 'v1.0/identity/conditionalAccess/policies').value)
foreach ($p in ($existing | Where-Object { $_.displayName -notlike 'BC - *' })) {
    Write-Host ("  other      {0} ({1}): not changed" -f $p.displayName, $p.state)
}

foreach ($policy in (Get-BcPolicies $app.appId $staff.id $excluded $deviceExcluded)) {
    $found = $existing | Where-Object { $_.displayName -eq $policy.displayName } | Select-Object -First 1
    if ($State) { $policy.state = $StateValue[$State] }
    if (-not $found) {
        if (-not $policy.state) { $policy.state = $StateValue.ReportOnly }
        if ($PSCmdlet.ShouldProcess($policy.displayName, "Create ($($policy.state))")) {
            Invoke-Graph POST 'v1.0/identity/conditionalAccess/policies' $policy | Out-Null
            Write-Host "  created    $($policy.displayName) ($($policy.state))"
        } else { Write-Host "  would      create $($policy.displayName) ($($policy.state))" }
    } else {
        $what = if ($State) { "update conditions, state -> $($policy.state)" } else { "update conditions (state stays $($found.state))" }
        if ($PSCmdlet.ShouldProcess($policy.displayName, $what)) {
            Invoke-Graph PATCH "v1.0/identity/conditionalAccess/policies/$($found.id)" $policy | Out-Null
            Write-Host "  updated    $($policy.displayName): $what"
        } else { Write-Host "  would      $($policy.displayName): $what" }
    }
}

if (-not $WhatIfPreference) {
    Write-Host ''
    Write-Host 'Next: leave them report-only for a day, read Sign-in logs > Report-only, then -State On (docs/tenant-setup.md).'
    Write-Host 'Export the policies as evidence: export-evidence.ps1 (or the admin centre''s download).'
}
Disconnect-MgGraph | Out-Null

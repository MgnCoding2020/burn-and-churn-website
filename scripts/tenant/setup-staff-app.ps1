<#
.SYNOPSIS
    Creates or updates the Entra ID app "bc-website-staff" and gives each Burn and Churn
    staff member their app role, from the hub's people.csv.

.DESCRIPTION
    The scripted version of docs/runbooks/entra-staff-app-registration.md (plan section 4.1,
    hub change record CR-002). Users and groups themselves are created by the hub's
    tools/tenant/provision-users.ps1; this script owns only what belongs to the website:

      1. Certificate   With -NewCertificate, makes a key pair with openssl in a folder
                       OUTSIDE the repository (default Documents\burn-and-churn-secrets).
      2. App           Single tenant; web redirect URIs (local and production); no implicit
                       grant; delegated openid and profile only; the four app roles with fixed
                       IDs; the certificate as its only credential (no client secret).
      3. Enterprise app  Created if missing; "Assignment required" = Yes, so people without
                       a role are refused by Entra itself.
      4. Consent       Admin consent for openid and profile.
      5. Roles         Reconciles role assignments with people.csv: adds missing ones, fixes
                       changed roles, removes them for people who left or lost their role.
                       People not yet created in the tenant are reported and skipped.
                       Assignments for anyone not in people.csv (a guest tester, say) are
                       reported and left alone.
      6. .dev.vars     With -WriteDevVars, writes tenant ID, client ID, thumbprint and private
                       key into the git-ignored .dev.vars. Values are never printed.

    Group to role mapping (plan section 4.1):
      grp-bc-owners -> Staff.Owner, grp-bc-managers -> Staff.Manager,
      grp-bc-shift-leads -> Staff.ShiftLead, grp-bc-baristas -> Staff.Barista.
    Default: each person is assigned directly (works on Entra ID Free). With -ByGroup the four
    groups are assigned instead and the direct assignments are removed; that needs Entra ID P1
    (Business Premium trial, Phase 7).

    Safe to run more than once. -WhatIf signs in read-only and shows every change without
    making it. Tenant ID and domain come from the hub's git-ignored .env; screen output and
    the log use the fictional domain only. Log: scripts/tenant/logs/ (git-ignored).

.PARAMETER HubPath
    The hub repository (grc-paper-project-coffee-shop). Default: the sibling folder.

.PARAMETER CertificatePath
    The public certificate (.crt or .cer) to upload. Default: bc-website-staff.crt in -SecretsDir.

.PARAMETER SecretsDir
    Where -NewCertificate writes the key pair. Must be outside the repository.

.PARAMETER NewCertificate
    Make a new certificate (RSA 2048, one year) with openssl. Refuses to overwrite one.

.PARAMETER ReplaceCertificate
    Replace the app's current certificate with -CertificatePath (yearly rotation).
    Graph can't add a key next to one it won't read back, so the old one is removed.

.PARAMETER ByGroup
    Assign the four groups to the roles instead of each person. Needs Entra ID P1.

.PARAMETER WriteDevVars
    Write the sign-in values into .dev.vars (created from .dev.vars.example if missing).

.EXAMPLE
    .\scripts\tenant\setup-staff-app.ps1 -NewCertificate -WhatIf
.EXAMPLE
    .\scripts\tenant\setup-staff-app.ps1 -NewCertificate -WriteDevVars
.EXAMPLE
    .\scripts\tenant\setup-staff-app.ps1 -ByGroup
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$HubPath,
    [string]$CertificatePath,
    [string]$SecretsDir = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'burn-and-churn-secrets'),
    [switch]$NewCertificate,
    [switch]$ReplaceCertificate,
    [switch]$ByGroup,
    [switch]$WriteDevVars
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AppName  = 'bc-website-staff'
$CertName = 'bc-website-staff'
$RedirectUris = @(
    'http://localhost:8787/api/v1/auth/staff/callback',
    'https://burn-and-churn-website.naultmichael.workers.dev/api/v1/auth/staff/callback'
)
$GraphAppId = '00000003-0000-0000-c000-000000000000'
# Microsoft Graph delegated permission IDs (the same in every tenant)
$GraphScopes = [ordered]@{ openid = '37f7f235-527c-4136-accd-4a02d197296e'; profile = '14dad69e-099b-42c9-810b-d002981feec1' }

# Fixed IDs, so a re-run never changes a role and existing assignments stay valid
$Roles = @(
    [pscustomobject]@{ value = 'Staff.Barista';   id = '8a614af6-b142-472e-9b36-c47287b120f1'; group = 'grp-bc-baristas';    rank = 1; name = 'Barista';    description = 'Takes orders and payments at the counter' }
    [pscustomobject]@{ value = 'Staff.ShiftLead'; id = '7201cfbf-5daa-4f3b-951c-3f25cc8b283a'; group = 'grp-bc-shift-leads'; rank = 2; name = 'Shift Lead'; description = 'Runs a shift: order board, sold-out items' }
    [pscustomobject]@{ value = 'Staff.Manager';   id = '1685def2-6e59-4666-ba57-999b4ae6f9c7'; group = 'grp-bc-managers';    rank = 3; name = 'Manager';    description = 'Menu, refunds, audit log' }
    [pscustomobject]@{ value = 'Staff.Owner';     id = 'ecdcedc2-1dd0-4051-968f-d35f20bd1f4d'; group = 'grp-bc-owners';      rank = 4; name = 'Owner';      description = 'Everything, including AI and payment summaries' }
)

# ---------------------------------------------------------------- helpers (no Graph calls)

function Read-DotEnv([string]$Path) {
    if (-not (Test-Path $Path)) { throw "Missing $Path. Copy .env.example to .env in the hub and fill in the tenant values." }
    $values = @{}
    foreach ($line in Get-Content $Path) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2] }
    }
    foreach ($key in 'ENTRA_TENANT_ID', 'ENTRA_TENANT_DOMAIN', 'BC_DOC_DOMAIN') {
        if (-not $values[$key]) { throw "$key is not set in $Path." }
    }
    return $values
}

# The highest app role a roster row earns from its groups, or $null (IT, terminated, no group)
function Get-DesiredRole($Person) {
    if ($Person.employment_status -ne 'Active') { return $null }
    $groups = @($Person.groups -split ';' | Where-Object { $_ })
    $earned = @($Roles | Where-Object { $groups -contains $_.group } | Sort-Object rank -Descending)
    if ($earned.Count) { return $earned[0] } else { return $null }
}

# Sets KEY=value lines in a dotenv file's text, adding any that are missing
function Set-DotEnvValues([string]$Text, [System.Collections.IDictionary]$Values) {
    $lines = [System.Collections.Generic.List[string]]($Text -split "`r?`n")
    foreach ($key in $Values.Keys) {
        $line = "$key=$($Values[$key])"
        $index = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$key\s*=") { $index = $i; break } }
        if ($index -ge 0) { $lines[$index] = $line } else { $lines.Add($line) }
    }
    return ($lines -join "`n")
}

# A PEM file as one dotenv value: double-quoted, line breaks written as \n
function ConvertTo-DotEnvPem([string]$Pem) {
    return '"' + (($Pem.Trim() -split "`r?`n") -join '\n') + '"'
}

function Find-OpenSsl {
    $candidates = @(
        (Get-Command openssl -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
        "$env:ProgramFiles\Git\mingw64\bin\openssl.exe",
        "$env:ProgramFiles\Git\usr\bin\openssl.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }
    if (-not $candidates) { throw 'openssl not found. Install Git for Windows (it includes openssl) or pass -CertificatePath.' }
    return @($candidates)[0]
}

# Whether an app's key credential is this certificate. Graph never returns the key itself,
# and customKeyIdentifier has been seen as the thumbprint's bytes or as its hex text (or
# missing), so accept either, and fall back to the same name and expiry date.
function Test-SameCertificate($Key, $Cert) {
    $id = [string]$Key.customKeyIdentifier
    if ($id) {
        if ($id -eq $Cert.Thumbprint) { return $true }
        try {
            $bytes = [Convert]::FromBase64String($id)
            if (([BitConverter]::ToString($bytes) -replace '-', '') -eq $Cert.Thumbprint) { return $true }
            if ([Text.Encoding]::ASCII.GetString($bytes) -eq $Cert.Thumbprint) { return $true }
        } catch { }
    }
    if ($Key.endDateTime -and $Key.displayName -eq $Cert.Subject) {
        $end = ([datetime]$Key.endDateTime).ToUniversalTime()
        if ([math]::Abs(($end - $Cert.NotAfter.ToUniversalTime()).TotalMinutes) -lt 2) { return $true }
    }
    return $false
}

# Dot-sourcing (tests) loads the helpers above and stops here
if ($MyInvocation.InvocationName -eq '.') { return }

# ---------------------------------------------------------------- inputs

if (-not $HubPath) { $HubPath = Join-Path (Split-Path $RepoRoot -Parent) 'grc-paper-project-coffee-shop' }
$PeopleCsv = Join-Path $HubPath '00-company-profile\org\people.csv'
if (-not (Test-Path $PeopleCsv)) { throw "people.csv not found under $HubPath. Pass -HubPath." }
$envValues  = Read-DotEnv (Join-Path $HubPath '.env')
$docDomain  = $envValues['BC_DOC_DOMAIN']
$realDomain = $envValues['ENTRA_TENANT_DOMAIN']
$tenantId   = $envValues['ENTRA_TENANT_ID']
function ConvertTo-RealUpn([string]$Upn) { $Upn -replace [regex]::Escape("@$docDomain"), "@$realDomain" }
function ConvertTo-DocUpn([string]$Upn) { $Upn -replace [regex]::Escape("@$realDomain"), "@$docDomain" }

$secretsFull = [IO.Path]::GetFullPath($SecretsDir)
if ($secretsFull.StartsWith($RepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "-SecretsDir must be outside the repository ($RepoRoot)."
}
if (-not $CertificatePath) { $CertificatePath = Join-Path $secretsFull "$CertName.crt" }
$keyPath = Join-Path (Split-Path $CertificatePath -Parent) "$CertName.pkcs8.pem"

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = New-Object System.Collections.Generic.List[object]
function Write-Step($Action, $Object, $Detail) {
    $log.Add([pscustomobject]@{ timestamp = (Get-Date -Format 's'); action = $Action; object = $Object; detail = $Detail })
    Write-Host ("  {0,-10} {1} {2}" -f $Action, $Object, $Detail)
}
$mode = if ($WhatIfPreference) { 'WHAT IF: nothing is changed' } else { 'changes are made' }
Write-Host "bc-website-staff setup ($mode)"

# ---------------------------------------------------------------- 1. certificate

if ($NewCertificate) {
    if (Test-Path $CertificatePath) {
        Write-Step 'exists' 'certificate' "$CertificatePath (not overwritten)"
    } elseif ($PSCmdlet.ShouldProcess($secretsFull, 'Create certificate and private key with openssl')) {
        $openssl = Find-OpenSsl
        New-Item -ItemType Directory -Force (Split-Path $CertificatePath -Parent) | Out-Null
        $rawKey = Join-Path (Split-Path $CertificatePath -Parent) "$CertName.key"
        & $openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes -keyout $rawKey -out $CertificatePath -subj "/CN=$CertName"
        if ($LASTEXITCODE) { throw 'openssl req failed.' }
        & $openssl pkcs8 -topk8 -nocrypt -in $rawKey -out $keyPath
        if ($LASTEXITCODE) { throw 'openssl pkcs8 failed.' }
        Remove-Item $rawKey
        Write-Step 'created' 'certificate' "$CertificatePath (+ private key next to it)"
    } else {
        Write-Step 'would' 'certificate' "create in $secretsFull"
    }
}
$cert = $null
if (Test-Path $CertificatePath) {
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [IO.File]::ReadAllBytes($CertificatePath))
    Write-Host ("  certificate thumbprint ends ...{0}, expires {1:yyyy-MM-dd}" -f $cert.Thumbprint.Substring(34), $cert.NotAfter)
    if ($cert.NotAfter -lt (Get-Date).AddDays(30)) { Write-Warning 'The certificate expires within 30 days: make a new one and use -ReplaceCertificate.' }
} elseif (-not $WhatIfPreference) {
    throw "No certificate at $CertificatePath. Use -NewCertificate, or pass -CertificatePath."
}

# ---------------------------------------------------------------- connect

if (-not (Get-Module -ListAvailable Microsoft.Graph.Authentication)) {
    throw 'Module Microsoft.Graph.Authentication is not installed. Run: Install-Module Microsoft.Graph.Authentication -Scope CurrentUser'
}
if ($WhatIfPreference) {
    $scopes = 'Directory.Read.All'
} else {
    $scopes = 'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All', 'User.Read.All', 'Group.Read.All'
}
Connect-MgGraph -TenantId $tenantId -Scopes $scopes -NoWelcome

function Invoke-Graph([string]$Method, [string]$Uri, $Body) {
    if ($null -ne $Body) {
        return Invoke-MgGraphRequest -Method $Method -Uri $Uri -Body ($Body | ConvertTo-Json -Depth 10) -ContentType 'application/json'
    }
    return Invoke-MgGraphRequest -Method $Method -Uri $Uri
}
function Get-All([string]$Uri) {
    $items = @()
    while ($Uri) { $page = Invoke-Graph GET $Uri; $items += @($page.value); $Uri = $page.'@odata.nextLink' }
    return $items
}

# ---------------------------------------------------------------- 2. app registration

$apps = @(Get-All "v1.0/applications?`$filter=displayName eq '$AppName'")
if ($apps.Count -gt 1) { throw "More than one app is named $AppName. Delete the extra one in the Entra admin centre first." }
$app = $apps | Select-Object -First 1

# Keep the ID of any role that already exists with the same value (made by hand, say)
$appRoles = foreach ($r in $Roles) {
    $existing = if ($app) { @($app.appRoles) | Where-Object { $_.value -eq $r.value } | Select-Object -First 1 }
    $roleId = if ($existing) { $existing.id } else { $r.id }
    $r.id = $roleId
    @{ id = $roleId; value = $r.value; displayName = $r.name; description = $r.description; allowedMemberTypes = @('User'); isEnabled = $true }
}
$desired = @{
    appRoles = @($appRoles)
    web = @{ redirectUris = $RedirectUris; implicitGrantSettings = @{ enableIdTokenIssuance = $false; enableAccessTokenIssuance = $false } }
    requiredResourceAccess = @(@{ resourceAppId = $GraphAppId; resourceAccess = @($GraphScopes.Values | ForEach-Object { @{ id = $_; type = 'Scope' } }) })
}

if (-not $app) {
    if ($PSCmdlet.ShouldProcess($AppName, 'Create app registration')) {
        $body = $desired.Clone()
        $body.displayName = $AppName
        $body.signInAudience = 'AzureADMyOrg'
        $body.description = 'Burn and Churn Coffee staff portal sign-in (fictional business, security portfolio project). CR-002.'
        $app = Invoke-Graph POST 'v1.0/applications' $body
        Write-Step 'created' 'app' "$AppName (single tenant, 4 roles, openid + profile)"
    } else {
        Write-Step 'would' 'app' "create $AppName (single tenant, 4 roles, openid + profile)"
    }
} else {
    $changes = @()
    if (((@($app.web.redirectUris) | Sort-Object) -join ' ') -ne ((@($RedirectUris) | Sort-Object) -join ' ')) { $changes += 'redirect URIs' }
    if ($app.web.implicitGrantSettings.enableIdTokenIssuance -or $app.web.implicitGrantSettings.enableAccessTokenIssuance) { $changes += 'implicit grant off' }
    foreach ($r in $Roles) {
        $have = @($app.appRoles) | Where-Object { $_.value -eq $r.value -and $_.isEnabled -and $_.displayName -eq $r.name -and $_.description -eq $r.description }
        if (-not $have) { $changes += "role $($r.value)" }
    }
    $extraRoles = @(@($app.appRoles) | Where-Object { $Roles.value -notcontains $_.value })
    if ($extraRoles.Count) { Write-Step 'note' 'app' "has other roles left alone: $(($extraRoles | ForEach-Object { $_.value }) -join ', ')"; $desired.appRoles += $extraRoles }
    $haveScopes = @(@($app.requiredResourceAccess) | Where-Object { $_.resourceAppId -eq $GraphAppId } | ForEach-Object { $_.resourceAccess } | ForEach-Object { $_.id }) | Sort-Object
    $otherApis = @(@($app.requiredResourceAccess) | Where-Object { $_.resourceAppId -ne $GraphAppId })
    if (($haveScopes -join ' ') -ne ((@($GraphScopes.Values) | Sort-Object) -join ' ') -or $otherApis.Count) { $changes += 'permissions (openid + profile only)' }
    if (@($app.passwordCredentials).Count) { Write-Warning "$AppName has a client secret. The site uses the certificate only: delete the secret in the admin centre." }
    if ($changes.Count -eq 0) {
        Write-Step 'exists' 'app' "$AppName (up to date)"
    } elseif ($PSCmdlet.ShouldProcess($AppName, "Update $($changes -join ', ')")) {
        Invoke-Graph PATCH "v1.0/applications/$($app.id)" $desired | Out-Null
        Write-Step 'updated' 'app' ($changes -join ', ')
    } else {
        Write-Step 'would' 'app' "update $($changes -join ', ')"
    }
}

# Certificate credential
if ($app -and $cert) {
    $keys = @($app.keyCredentials)
    $match = $keys | Where-Object { Test-SameCertificate $_ $cert }
    $keyBody = @{ keyCredentials = @(@{ type = 'AsymmetricX509Cert'; usage = 'Verify'; key = [Convert]::ToBase64String($cert.RawData); displayName = "CN=$CertName" }) }
    if ($match) {
        Write-Step 'exists' 'credential' 'certificate already uploaded'
    } elseif ($keys.Count -and -not $ReplaceCertificate) {
        Write-Step 'skipped' 'credential' 'the app has a different certificate; use -ReplaceCertificate to rotate'
    } elseif ($PSCmdlet.ShouldProcess($AppName, 'Upload certificate (replacing any other)')) {
        Invoke-Graph PATCH "v1.0/applications/$($app.id)" $keyBody | Out-Null
        Write-Step 'uploaded' 'credential' ("certificate, expires {0:yyyy-MM-dd}" -f $cert.NotAfter)
    } else {
        Write-Step 'would' 'credential' 'upload certificate'
    }
} elseif (-not $app) {
    Write-Step 'would' 'credential' 'upload certificate'
}

# ---------------------------------------------------------------- 3. enterprise app

$sp = $null
if ($app) { $sp = @(Get-All "v1.0/servicePrincipals?`$filter=appId eq '$($app.appId)'") | Select-Object -First 1 }
if (-not $sp) {
    if ($app -and $PSCmdlet.ShouldProcess($AppName, 'Create enterprise app with Assignment required = Yes')) {
        $sp = Invoke-Graph POST 'v1.0/servicePrincipals' @{ appId = $app.appId; appRoleAssignmentRequired = $true; tags = @('WindowsAzureActiveDirectoryIntegratedApp') }
        Write-Step 'created' 'enterprise' "$AppName, assignment required"
    } else {
        Write-Step 'would' 'enterprise' "create $AppName, assignment required"
    }
} elseif (-not $sp.appRoleAssignmentRequired) {
    if ($PSCmdlet.ShouldProcess($AppName, 'Set Assignment required = Yes')) {
        Invoke-Graph PATCH "v1.0/servicePrincipals/$($sp.id)" @{ appRoleAssignmentRequired = $true } | Out-Null
        Write-Step 'updated' 'enterprise' 'assignment required = Yes'
    } else {
        Write-Step 'would' 'enterprise' 'set assignment required = Yes'
    }
} else {
    Write-Step 'exists' 'enterprise' "$AppName, assignment required"
}

# ---------------------------------------------------------------- 4. admin consent

$graphSp = @(Get-All "v1.0/servicePrincipals?`$filter=appId eq '$GraphAppId'") | Select-Object -First 1
$wantScope = ($GraphScopes.Keys) -join ' '
$grant = $null
if ($sp) { $grant = @(Get-All "v1.0/oauth2PermissionGrants?`$filter=clientId eq '$($sp.id)'") | Where-Object { $_.consentType -eq 'AllPrincipals' -and $_.resourceId -eq $graphSp.id } | Select-Object -First 1 }
if ($grant -and (($grant.scope -split ' ' | Where-Object { $_ } | Sort-Object) -join ' ') -eq (($GraphScopes.Keys | Sort-Object) -join ' ')) {
    Write-Step 'exists' 'consent' $wantScope
} elseif ($grant) {
    if ($PSCmdlet.ShouldProcess($AppName, "Set admin consent to '$wantScope'")) {
        Invoke-Graph PATCH "v1.0/oauth2PermissionGrants/$($grant.id)" @{ scope = $wantScope } | Out-Null
        Write-Step 'updated' 'consent' "$wantScope (was: $($grant.scope))"
    } else {
        Write-Step 'would' 'consent' "change to $wantScope (now: $($grant.scope))"
    }
} elseif ($sp -and $PSCmdlet.ShouldProcess($AppName, "Grant admin consent for '$wantScope'")) {
    Invoke-Graph POST 'v1.0/oauth2PermissionGrants' @{ clientId = $sp.id; consentType = 'AllPrincipals'; resourceId = $graphSp.id; scope = $wantScope } | Out-Null
    Write-Step 'granted' 'consent' $wantScope
} else {
    Write-Step 'would' 'consent' "grant $wantScope"
}

# ---------------------------------------------------------------- 5. role assignments

$assignments = if ($sp) { @(Get-All "v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo") } else { @() }
$roleById = @{}; foreach ($r in $Roles) { $roleById[$r.id] = $r }
$people = @(Import-Csv $PeopleCsv)
$rosterIds = @{}
$missing = 0

function Add-Assignment($PrincipalId, $Role, $Label) {
    if ($sp -and $PSCmdlet.ShouldProcess($Label, "Assign $($Role.value)")) {
        Invoke-Graph POST "v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo" @{ principalId = $PrincipalId; resourceId = $sp.id; appRoleId = $Role.id } | Out-Null
        Write-Step 'assigned' $Label $Role.value
    } else {
        Write-Step 'would' $Label "assign $($Role.value)"
    }
}
function Remove-Assignment($Assignment, $Label, $Why) {
    $was = $roleById[$Assignment.appRoleId].value
    if ($PSCmdlet.ShouldProcess($Label, "Remove $was ($Why)")) {
        Invoke-Graph DELETE "v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo/$($Assignment.id)" | Out-Null
        Write-Step 'removed' $Label "$was ($Why)"
    } else {
        Write-Step 'would' $Label "remove $was ($Why)"
    }
}

if ($ByGroup) {
    foreach ($r in $Roles) {
        $group = @(Get-All "v1.0/groups?`$filter=displayName eq '$($r.group)'") | Select-Object -First 1
        if (-not $group) { Write-Step 'missing' $r.group 'group not in tenant yet (hub provision-users.ps1)'; continue }
        $rosterIds[$group.id] = $true
        $have = @($assignments | Where-Object { $_.principalId -eq $group.id })
        if ($have | Where-Object { $_.appRoleId -eq $r.id }) { Write-Step 'exists' $r.group $r.value }
        else { Add-Assignment $group.id $r $r.group }
        foreach ($a in ($have | Where-Object { $_.appRoleId -ne $r.id })) { Remove-Assignment $a $r.group 'wrong role' }
    }
}

foreach ($p in $people) {
    $upn = ConvertTo-RealUpn $p.upn
    $user = @(Get-All "v1.0/users?`$filter=userPrincipalName eq '$upn'&`$select=id") | Select-Object -First 1
    $want = Get-DesiredRole $p
    if (-not $user) {
        if ($want) { $missing++; Write-Step 'missing' $p.upn "not in tenant yet ($($want.value) when created)" }
        continue
    }
    $rosterIds[$user.id] = $true
    $have = @($assignments | Where-Object { $_.principalId -eq $user.id })
    if ($ByGroup) {
        foreach ($a in $have) { Remove-Assignment $a $p.upn 'now through group' }
        continue
    }
    if (-not $want) {
        foreach ($a in $have) { Remove-Assignment $a $p.upn "$($p.employment_status) $($p.role): no staff app role" }
        if (-not $have.Count) { Write-Step 'none' $p.upn "$($p.role): no staff app role" }
        continue
    }
    if ($have | Where-Object { $_.appRoleId -eq $want.id }) { Write-Step 'exists' $p.upn $want.value }
    else { Add-Assignment $user.id $want $p.upn }
    foreach ($a in ($have | Where-Object { $_.appRoleId -ne $want.id })) { Remove-Assignment $a $p.upn 'role changed' }
}
foreach ($a in ($assignments | Where-Object { -not $rosterIds[$_.principalId] })) {
    Write-Step 'unmanaged' $a.principalDisplayName "$($roleById[$a.appRoleId].value) ($($a.principalType), not in people.csv: left alone)"
}

# ---------------------------------------------------------------- 6. .dev.vars

if ($WriteDevVars) {
    $devVars = Join-Path $RepoRoot '.dev.vars'
    if (-not $app -or -not $cert -or -not (Test-Path $keyPath)) {
        Write-Step 'would' '.dev.vars' 'write tenant ID, client ID, thumbprint and private key (after the app exists)'
    } elseif ($PSCmdlet.ShouldProcess($devVars, 'Write staff sign-in values')) {
        $text = if (Test-Path $devVars) { [IO.File]::ReadAllText($devVars) } else { [IO.File]::ReadAllText((Join-Path $RepoRoot '.dev.vars.example')) }
        $text = Set-DotEnvValues $text ([ordered]@{
            ENTRA_STAFF_TENANT_ID        = $tenantId
            ENTRA_STAFF_CLIENT_ID        = $app.appId
            ENTRA_STAFF_CERT_THUMBPRINT  = $cert.Thumbprint
            ENTRA_STAFF_CERT_PRIVATE_KEY = ConvertTo-DotEnvPem ([IO.File]::ReadAllText($keyPath))
        })
        [IO.File]::WriteAllText($devVars, $text, (New-Object System.Text.UTF8Encoding $false))
        Write-Step 'written' '.dev.vars' 'tenant ID, client ID, thumbprint, private key (values not shown)'
    }
}

# ---------------------------------------------------------------- done

$logPath = Join-Path $logDir "setup-staff-app-$stamp.csv"
$log | Export-Csv $logPath -NoTypeInformation -Encoding UTF8
Write-Host ''
Write-Host "Log (fictional domain only): $logPath"
if ($missing) { Write-Host "$missing roster people aren't in the tenant yet: run the hub's provision-users.ps1, then this script again." }
if (-not $WhatIfPreference) {
    Write-Host 'Next: record it in the hub CR-002 log and docs/secrets-inventory.md (certificate expiry date).'
}
Disconnect-MgGraph | Out-Null

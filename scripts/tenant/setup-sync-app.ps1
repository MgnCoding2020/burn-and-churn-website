<#
.SYNOPSIS
    Creates the Entra ID app "bc-website-sync" that reads the website's SharePoint lists,
    and grants it read on exactly those lists.

.DESCRIPTION
    Trial day 1 (plan section 5; docs/contracts/sharepoint-lists.md; docs/tenant-setup.md). One app
    per job: bc-website-staff signs people in; this app only reads lists, app-only.

      1. Certificate   With -NewCertificate, an RSA 2048 key pair (one year) made with openssl
                       OUTSIDE the repository (default Documents\burn-and-churn-secrets).
      2. App           Single tenant; no redirect URIs; one Graph APPLICATION permission,
                       Lists.SelectedOperations.Selected (its ID read from Graph, not typed
                       in); the certificate as its only credential.
      3. Enterprise    The service principal, created if missing.
      4. Consent       Admin consent for that one permission. On its own it reaches nothing:
                       Selected scopes need an explicit grant per list (step 5).
      5. Grants        Read on each list marked "websiteReads" in the contract, plus the
                       site's hidden User Information List (the Schedule's person column,
                       trial test T-SP-05). Nothing else on the site, and no other site.
      6. .dev.vars     With -WriteDevVars, writes the app's client ID, thumbprint, private key,
                       the site ID and each list's ID into the git-ignored .dev.vars. Values
                       are never printed.

    Run setup-sharepoint.ps1 first (the site and lists must exist). Safe to run more than
    once. -WhatIf signs in read-only and shows every change without making it.
    Then: node scripts/tenant/check-sync-access.mjs proves what the app can and can't read.

.PARAMETER HubPath
    The hub repository (grc-paper-project-coffee-shop), for its .env. Default: the sibling folder.

.PARAMETER SecretsDir
    Where -NewCertificate writes the key pair. Must be outside the repository.

.EXAMPLE
    .\scripts\tenant\setup-sync-app.ps1 -NewCertificate -WhatIf
.EXAMPLE
    .\scripts\tenant\setup-sync-app.ps1 -NewCertificate -WriteDevVars
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$HubPath,
    [string]$SecretsDir = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'burn-and-churn-secrets'),
    [switch]$NewCertificate,
    [switch]$WriteDevVars
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
# Shared helpers (Read-DotEnv, Set-DotEnvValues, ConvertTo-DotEnvPem, Find-OpenSsl). Dot-sourcing
# runs that script's param block here too, and its parameters share these names, so keep ours.
$mine = @{ HubPath = $HubPath; SecretsDir = $SecretsDir; NewCertificate = $NewCertificate; WriteDevVars = $WriteDevVars }
. (Join-Path $PSScriptRoot 'setup-staff-app.ps1')
$HubPath = $mine.HubPath; $SecretsDir = $mine.SecretsDir; $NewCertificate = $mine.NewCertificate; $WriteDevVars = $mine.WriteDevVars

$AppName   = 'bc-website-sync'
$CertName  = 'bc-website-sync'
$Scope     = 'Lists.SelectedOperations.Selected'
$GraphAppId = '00000003-0000-0000-c000-000000000000'
$UserInfoList = 'User Information List'
$contract = Get-Content (Join-Path $RepoRoot 'docs\contracts\sharepoint-lists.json') -Raw | ConvertFrom-Json

# The dotenv name for a list's ID, e.g. StoreHours -> SHAREPOINT_LIST_STOREHOURS
function Get-ListVarName([string]$Name) { 'SHAREPOINT_LIST_' + ($Name -replace '[^A-Za-z0-9]', '').ToUpperInvariant() }

if ($MyInvocation.InvocationName -eq '.') { return }

# ---------------------------------------------------------------- inputs

if (-not $HubPath) { $HubPath = Join-Path (Split-Path $RepoRoot -Parent) 'grc-paper-project-coffee-shop' }
$envValues = Read-DotEnv (Join-Path $HubPath '.env')
$tenantId  = $envValues['ENTRA_TENANT_ID']
$secretsFull = [IO.Path]::GetFullPath($SecretsDir)
if ($secretsFull.StartsWith($RepoRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "-SecretsDir must be outside the repository ($RepoRoot)." }
$certPath = Join-Path $secretsFull "$CertName.crt"
$keyPath  = Join-Path $secretsFull "$CertName.pkcs8.pem"

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = New-Object System.Collections.Generic.List[object]
function Write-Step($Action, $Object, $Detail) {
    $log.Add([pscustomobject]@{ timestamp = (Get-Date -Format 's'); action = $Action; object = $Object; detail = $Detail })
    Write-Host ("  {0,-10} {1} {2}" -f $Action, $Object, $Detail)
}
$mode = if ($WhatIfPreference) { 'WHAT IF: nothing is changed' } else { 'changes are made' }
Write-Host "$AppName setup ($mode)"

# ---------------------------------------------------------------- 1. certificate

if ($NewCertificate) {
    if (Test-Path $certPath) {
        Write-Step 'exists' 'certificate' "$certPath (not overwritten)"
    } elseif ($PSCmdlet.ShouldProcess($secretsFull, 'Create certificate and private key with openssl')) {
        $openssl = Find-OpenSsl
        New-Item -ItemType Directory -Force $secretsFull | Out-Null
        $rawKey = Join-Path $secretsFull "$CertName.key"
        & $openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes -keyout $rawKey -out $certPath -subj "/CN=$CertName"
        if ($LASTEXITCODE) { throw 'openssl req failed.' }
        & $openssl pkcs8 -topk8 -nocrypt -in $rawKey -out $keyPath
        if ($LASTEXITCODE) { throw 'openssl pkcs8 failed.' }
        Remove-Item $rawKey
        Write-Step 'created' 'certificate' "$certPath (+ private key next to it)"
    } else {
        Write-Step 'would' 'certificate' "create in $secretsFull"
    }
}
$cert = $null
if (Test-Path $certPath) {
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [IO.File]::ReadAllBytes($certPath))
    Write-Host ("  certificate expires {0:yyyy-MM-dd}" -f $cert.NotAfter)
} elseif (-not $WhatIfPreference) {
    throw "No certificate at $certPath. Use -NewCertificate."
}

# ---------------------------------------------------------------- connect

$scopes = if ($WhatIfPreference) { 'Application.Read.All', 'Sites.Read.All' } else { 'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Sites.FullControl.All' }
Connect-MgGraph -TenantId $tenantId -Scopes $scopes -NoWelcome
function Invoke-Graph([string]$Method, [string]$Uri, $Body) {
    if ($null -ne $Body) { return Invoke-MgGraphRequest -Method $Method -Uri $Uri -Body ($Body | ConvertTo-Json -Depth 10) -ContentType 'application/json' }
    return Invoke-MgGraphRequest -Method $Method -Uri $Uri
}
function Get-All([string]$Uri) {
    $items = @()
    while ($Uri) { $page = Invoke-Graph GET $Uri; $items += @($page.value); $Uri = $page.'@odata.nextLink' }
    return $items
}

$graphSp = @(Get-All "v1.0/servicePrincipals?`$filter=appId eq '$GraphAppId'") | Select-Object -First 1
$role = @($graphSp.appRoles) | Where-Object { $_.value -eq $Scope } | Select-Object -First 1
if (-not $role) { throw "Graph has no application permission named $Scope in this tenant." }

# ---------------------------------------------------------------- 2. app and 3. enterprise app

$app = @(Get-All "v1.0/applications?`$filter=displayName eq '$AppName'") | Select-Object -First 1
$access = @(@{ resourceAppId = $GraphAppId; resourceAccess = @(@{ id = $role.id; type = 'Role' }) })
if (-not $app) {
    if ($PSCmdlet.ShouldProcess($AppName, "Create app registration ($Scope only)")) {
        $app = Invoke-Graph POST 'v1.0/applications' @{
            displayName = $AppName; signInAudience = 'AzureADMyOrg'; requiredResourceAccess = $access
            description = 'Burn and Churn Coffee website: reads its SharePoint lists, app-only (fictional business, security portfolio project). CR-002.'
        }
        Write-Step 'created' 'app' "$AppName ($Scope only)"
    } else {
        Write-Step 'would' 'app' "create $AppName ($Scope only, no redirect URIs)"
    }
} else {
    $haveIds = @(@($app.requiredResourceAccess) | ForEach-Object { $_.resourceAccess } | ForEach-Object { $_.id })
    if ($haveIds.Count -ne 1 -or $haveIds[0] -ne $role.id) {
        if ($PSCmdlet.ShouldProcess($AppName, "Set permissions to $Scope only")) {
            Invoke-Graph PATCH "v1.0/applications/$($app.id)" @{ requiredResourceAccess = $access } | Out-Null
            Write-Step 'updated' 'app' "permissions: $Scope only"
        } else { Write-Step 'would' 'app' "set permissions to $Scope only" }
    } else { Write-Step 'exists' 'app' "$AppName (up to date)" }
    if (@($app.passwordCredentials).Count) { Write-Warning "$AppName has a client secret. It should use the certificate only: delete the secret." }
}

if ($app -and $cert) {
    $match = @($app.keyCredentials) | Where-Object { $_.customKeyIdentifier -and ([BitConverter]::ToString([Convert]::FromBase64String($_.customKeyIdentifier)) -replace '-', '') -eq $cert.Thumbprint }
    if ($match) { Write-Step 'exists' 'credential' 'certificate already uploaded' }
    elseif ($PSCmdlet.ShouldProcess($AppName, 'Upload certificate')) {
        Invoke-Graph PATCH "v1.0/applications/$($app.id)" @{ keyCredentials = @(@{ type = 'AsymmetricX509Cert'; usage = 'Verify'; key = [Convert]::ToBase64String($cert.RawData); displayName = "CN=$CertName" }) } | Out-Null
        Write-Step 'uploaded' 'credential' ("certificate, expires {0:yyyy-MM-dd}" -f $cert.NotAfter)
    } else { Write-Step 'would' 'credential' 'upload certificate' }
}

$sp = if ($app) { @(Get-All "v1.0/servicePrincipals?`$filter=appId eq '$($app.appId)'") | Select-Object -First 1 }
if (-not $sp) {
    if ($app -and $PSCmdlet.ShouldProcess($AppName, 'Create enterprise app')) {
        $sp = Invoke-Graph POST 'v1.0/servicePrincipals' @{ appId = $app.appId }
        Write-Step 'created' 'enterprise' $AppName
    } else { Write-Step 'would' 'enterprise' "create $AppName" }
} else { Write-Step 'exists' 'enterprise' $AppName }

# ---------------------------------------------------------------- 4. admin consent (application permission)

$consented = if ($sp) { @(Get-All "v1.0/servicePrincipals/$($sp.id)/appRoleAssignments") | Where-Object { $_.appRoleId -eq $role.id -and $_.resourceId -eq $graphSp.id } }
if ($consented) { Write-Step 'exists' 'consent' $Scope }
elseif ($sp -and $PSCmdlet.ShouldProcess($AppName, "Grant admin consent for $Scope")) {
    Invoke-Graph POST "v1.0/servicePrincipals/$($graphSp.id)/appRoleAssignedTo" @{ principalId = $sp.id; resourceId = $graphSp.id; appRoleId = $role.id } | Out-Null
    Write-Step 'granted' 'consent' $Scope
} else { Write-Step 'would' 'consent' "grant $Scope (reaches nothing until step 5)" }

# ---------------------------------------------------------------- 5. per-list read grants

$hostname = (Invoke-Graph GET 'v1.0/sites/root?$select=siteCollection').siteCollection.hostname
$site = $null
try { $site = Invoke-Graph GET "v1.0/sites/${hostname}:$($contract.site.path)?`$select=id,webUrl" } catch { }
if (-not $site) { throw "Site $($contract.site.path) not found. Run setup-sharepoint.ps1 first." }
$lists = @(Get-All "v1.0/sites/$($site.id)/lists?`$select=id,name,displayName&`$top=200")
$listIds = [ordered]@{}

$targets = @($contract.lists | Where-Object { $_.websiteReads } | ForEach-Object { $n = $_.name; [pscustomobject]@{ label = $n; list = ($lists | Where-Object { $_.name -eq $n } | Select-Object -First 1) } })
$targets += [pscustomobject]@{ label = $UserInfoList; list = ($lists | Where-Object { $_.displayName -eq $UserInfoList } | Select-Object -First 1) }

foreach ($t in $targets) {
    if (-not $t.list) { Write-Step 'missing' "list $($t.label)" 'not found on the site (run setup-sharepoint.ps1; for the User Information List see T-SP-05)'; continue }
    $listIds[$t.label] = $t.list.id
    $have = $null
    if ($app) {
        $perms = @(Get-All "v1.0/sites/$($site.id)/lists/$($t.list.id)/permissions")
        $have = $perms | Where-Object { @($_.grantedToIdentitiesV2 + $_.grantedToIdentities) | Where-Object { $_.application.id -eq $app.appId } } | Select-Object -First 1
    }
    if ($have -and @($have.roles) -contains 'read' -and @($have.roles).Count -eq 1) { Write-Step 'exists' "grant $($t.label)" 'read' }
    elseif ($have) { Write-Step 'CHECK' "grant $($t.label)" "has roles $(@($have.roles) -join ', '), expected read only: fix by hand" }
    elseif ($app -and $PSCmdlet.ShouldProcess("list $($t.label)", "Grant $AppName read")) {
        Invoke-Graph POST "v1.0/sites/$($site.id)/lists/$($t.list.id)/permissions" @{
            roles = @('read'); grantedToIdentities = @(@{ application = @{ id = $app.appId; displayName = $AppName } })
        } | Out-Null
        Write-Step 'granted' "list $($t.label)" 'read'
    } else { Write-Step 'would' "list $($t.label)" "grant $AppName read" }
}

# ---------------------------------------------------------------- 6. .dev.vars

if ($WriteDevVars) {
    $devVars = Join-Path $RepoRoot '.dev.vars'
    if (-not $app -or -not $cert -or -not (Test-Path $keyPath)) {
        Write-Step 'would' '.dev.vars' 'write the sync values (after the app exists)'
    } elseif ($PSCmdlet.ShouldProcess($devVars, 'Write SharePoint sync values')) {
        $values = [ordered]@{
            GRAPH_CLIENT_ID        = $app.appId
            GRAPH_CERT_THUMBPRINT  = $cert.Thumbprint
            GRAPH_CERT_PRIVATE_KEY = ConvertTo-DotEnvPem ([IO.File]::ReadAllText($keyPath))
            SHAREPOINT_SITE_ID     = $site.id
        }
        foreach ($k in $listIds.Keys) { $values[(Get-ListVarName $k)] = $listIds[$k] }
        $text = if (Test-Path $devVars) { [IO.File]::ReadAllText($devVars) } else { [IO.File]::ReadAllText((Join-Path $RepoRoot '.dev.vars.example')) }
        [IO.File]::WriteAllText($devVars, (Set-DotEnvValues $text $values), (New-Object System.Text.UTF8Encoding $false))
        Write-Step 'written' '.dev.vars' "client ID, thumbprint, private key, site ID, $($listIds.Count) list IDs (values not shown)"
    }
}

# ---------------------------------------------------------------- done

$logPath = Join-Path $logDir "setup-sync-app-$stamp.csv"
$log | Export-Csv $logPath -NoTypeInformation -Encoding UTF8
Write-Host ''
Write-Host "Log: $logPath"
if (-not $WhatIfPreference) {
    Write-Host 'Next: node scripts/tenant/check-sync-access.mjs  (proves read on these lists, 403 everywhere else),'
    Write-Host '      then record the certificate expiry in docs/secrets-inventory.md.'
}
Disconnect-MgGraph | Out-Null

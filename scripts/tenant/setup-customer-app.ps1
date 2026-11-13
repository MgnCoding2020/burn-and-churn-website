<#
.SYNOPSIS
    Creates or updates the customer sign-in app "bc-website-customers" and its sign-up and sign-in
    user flow (email one-time codes only) in the customer directory.

.DESCRIPTION
    Phase 5 (plan section 4.2; ADR-0042). Runs against the customer directory (Entra External ID),
    never the staff tenant. The tenant ID comes from ENTRA_CUSTOMER_TENANT_ID in the git-ignored
    .dev.vars (written by setup-customer-directory.ps1).

      1. Certificate   With -NewCertificate, makes a key pair with openssl in a folder OUTSIDE the
                       repository (default Documents\burn-and-churn-secrets). A different key from
                       the staff app's.
      2. App           This directory only; web redirect URIs (local and production); no implicit
                       grant; delegated openid and profile only; no app roles; the certificate as
                       its only credential (no client secret).
      3. Enterprise app  Created if missing. Assignment is NOT required: anyone may sign up.
      4. Consent       Admin consent for openid and profile, so customers aren't asked.
      5. User flow     "bc-customers-sign-up-sign-in": sign-up allowed, email one-time passcode as
                       the only method (no passwords), collects the email (hidden) and a display
                       name. The app is linked to it.
      6. .dev.vars     With -WriteDevVars, writes the client ID, thumbprint and private key into
                       the git-ignored .dev.vars. Values are never printed.

    Safety: refuses unless Graph reports a customer directory (tenantType CIAM), and refuses the
    staff tenant's ID from the hub's .env. Safe to run more than once. -WhatIf signs in read-only
    and shows every change without making it. Log: scripts/tenant/logs/ (git-ignored).

.PARAMETER TenantId
    The customer directory's tenant ID. Default: ENTRA_CUSTOMER_TENANT_ID from .dev.vars.

.PARAMETER NewCertificate
    Make a new certificate (RSA 2048, one year) with openssl. Refuses to overwrite one.

.PARAMETER ReplaceCertificate
    Replace the app's current certificate with -CertificatePath (yearly rotation).

.PARAMETER WriteDevVars
    Write the client ID, thumbprint and private key into .dev.vars.

.EXAMPLE
    .\scripts\tenant\setup-customer-app.ps1 -NewCertificate -WhatIf
.EXAMPLE
    .\scripts\tenant\setup-customer-app.ps1 -NewCertificate -WriteDevVars
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')][string]$TenantId,
    [string]$HubPath,
    [string]$CertificatePath,
    [string]$SecretsDir = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'burn-and-churn-secrets'),
    [switch]$NewCertificate,
    [switch]$ReplaceCertificate,
    [switch]$WriteDevVars
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AppName  = 'bc-website-customers'
$CertName = 'bc-website-customers'
$FlowName = 'bc-customers-sign-up-sign-in'
$EmailOtp = 'EmailOtpSignup-OAUTH'
$RedirectUris = @(
    'http://localhost:8787/api/v1/auth/customer/callback',
    'https://burn-and-churn-website.naultmichael.workers.dev/api/v1/auth/customer/callback'
)
$GraphAppId = '00000003-0000-0000-c000-000000000000'
# Microsoft Graph delegated permission IDs (the same in every tenant)
$GraphScopes = [ordered]@{ openid = '37f7f235-527c-4136-accd-4a02d197296e'; profile = '14dad69e-099b-42c9-810b-d002981feec1' }
$GuidPattern = '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'

# ---------------------------------------------------------------- helpers (no Graph calls)

function Read-DevVar([string]$Root, [string]$Key) {
    $f = Join-Path $Root '.dev.vars'
    if (Test-Path $f) {
        $line = Get-Content $f | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
        if ($line) { return ($line -replace '^[^=]*=\s*', '' -replace '["'']', '').Trim() }
    }
    $null
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

# Whether an app's key credential is this certificate (same rules as setup-staff-app.ps1).
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

# The sign-up and sign-in user flow: email one-time passcode only, sign-up allowed, the email
# (hidden, from the code step) and a display name collected.
function New-FlowBody([string]$AppId) {
    @{
        '@odata.type' = '#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow'
        displayName   = $FlowName
        description   = 'Burn and Churn Coffee customers (fictional business, security portfolio project): email one-time codes only. CR-002, ADR-0042.'
        conditions    = @{ applications = @{ includeApplications = @(@{ appId = $AppId }) } }
        onAuthenticationMethodLoadStart = @{
            '@odata.type'     = '#microsoft.graph.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp'
            identityProviders = @(@{ id = $EmailOtp })
        }
        onInteractiveAuthFlowStart = @{
            '@odata.type'   = '#microsoft.graph.onInteractiveAuthFlowStartExternalUsersSelfServiceSignUp'
            isSignUpAllowed = $true
        }
        onAttributeCollection = @{
            '@odata.type' = '#microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp'
            attributes    = @(
                @{ id = 'email'; displayName = 'Email Address'; description = 'Email address of the user'; userFlowAttributeType = 'builtIn'; dataType = 'string' }
                @{ id = 'displayName'; displayName = 'Display Name'; description = 'Display Name of the User.'; userFlowAttributeType = 'builtIn'; dataType = 'string' }
            )
            attributeCollectionPage = @{
                views = @(@{
                    inputs = @(
                        @{ attribute = 'email'; label = 'Email address'; inputType = 'text'; hidden = $true; editable = $false; writeToDirectory = $true; required = $true }
                        @{ attribute = 'displayName'; label = 'Your name (shown on your orders)'; inputType = 'text'; hidden = $false; editable = $true; writeToDirectory = $true; required = $true }
                    )
                })
            }
        }
    }
}

# Dot-sourcing (tests) loads the helpers above and stops here
if ($MyInvocation.InvocationName -eq '.') { return }

# ---------------------------------------------------------------- inputs and guards

if (-not $TenantId) {
    $fromFile = Read-DevVar $RepoRoot 'ENTRA_CUSTOMER_TENANT_ID'
    if ($fromFile -notmatch $GuidPattern) { throw 'No customer tenant ID: pass -TenantId, or set ENTRA_CUSTOMER_TENANT_ID in .dev.vars (setup-customer-directory.ps1 does this).' }
    $TenantId = $fromFile
}
if (-not $HubPath) { $HubPath = Join-Path (Split-Path $RepoRoot -Parent) 'grc-paper-project-coffee-shop' }
$hubEnv = Join-Path $HubPath '.env'
if (Test-Path $hubEnv) {
    $staffTenant = (Get-Content $hubEnv | Where-Object { $_ -match '^\s*ENTRA_TENANT_ID\s*=' } | Select-Object -First 1) -replace '^[^=]*=\s*', '' -replace '["'']', ''
    if ($staffTenant -and $staffTenant.Trim() -eq $TenantId) { throw 'That is the staff tenant (hub .env ENTRA_TENANT_ID). Use the customer directory''s tenant ID.' }
}
# Az.Accounts and Microsoft.Graph.Authentication ship different versions of the same libraries;
# with Az loaded first, Graph calls fail with "Method not found" (seen 2026-11-12).
if (Get-Module Az.Accounts) { throw 'Az.Accounts is loaded in this terminal (from setup-customer-directory.ps1), which breaks Microsoft Graph. Open a new terminal and run this script there.' }

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
Write-Host "bc-website-customers setup ($mode)"

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
    $scopes = 'Application.Read.All', 'EventListener.Read.All', 'IdentityProvider.Read.All'
} else {
    $scopes = 'Application.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All', 'EventListener.ReadWrite.All', 'IdentityProvider.Read.All'
}
Connect-MgGraph -TenantId $TenantId -Scopes $scopes -NoWelcome

function Invoke-Graph([string]$Method, [string]$Uri, $Body) {
    if ($null -ne $Body) {
        return Invoke-MgGraphRequest -Method $Method -Uri $Uri -Body ($Body | ConvertTo-Json -Depth 12) -ContentType 'application/json'
    }
    return Invoke-MgGraphRequest -Method $Method -Uri $Uri
}
function Get-All([string]$Uri) {
    $items = @()
    while ($Uri) { $page = Invoke-Graph GET $Uri; $items += @($page.value); $Uri = $page.'@odata.nextLink' }
    return $items
}

$org = (Invoke-Graph GET 'v1.0/organization?$select=displayName,tenantType').value | Select-Object -First 1
if ($org.tenantType -ne 'CIAM') { throw "This tenant's type is '$($org.tenantType)', not a customer directory (CIAM). Nothing was changed." }
Write-Step 'checked' 'directory' "$($org.displayName) (customer directory)"

$otp = @(Get-All 'v1.0/identity/identityProviders') | Where-Object { $_.id -eq $EmailOtp } | Select-Object -First 1
if (-not $otp) { throw "The directory has no '$EmailOtp' identity provider. Check Entra ID > External Identities > All identity providers. Nothing was changed." }
Write-Step 'checked' 'provider' "$EmailOtp ($($otp.displayName))"

# ---------------------------------------------------------------- 2. app registration

$apps = @(Get-All "v1.0/applications?`$filter=displayName eq '$AppName'")
if ($apps.Count -gt 1) { throw "More than one app is named $AppName. Delete the extra one in the Entra admin centre first." }
$app = $apps | Select-Object -First 1

$desired = @{
    web = @{ redirectUris = $RedirectUris; implicitGrantSettings = @{ enableIdTokenIssuance = $false; enableAccessTokenIssuance = $false } }
    requiredResourceAccess = @(@{ resourceAppId = $GraphAppId; resourceAccess = @($GraphScopes.Values | ForEach-Object { @{ id = $_; type = 'Scope' } }) })
}

if (-not $app) {
    if ($PSCmdlet.ShouldProcess($AppName, 'Create app registration')) {
        $body = $desired.Clone()
        $body.displayName = $AppName
        $body.signInAudience = 'AzureADMyOrg'
        $body.description = 'Burn and Churn Coffee customer sign-in (fictional business, security portfolio project). CR-002.'
        $app = Invoke-Graph POST 'v1.0/applications' $body
        Write-Step 'created' 'app' "$AppName (this directory only, openid + profile)"
    } else {
        Write-Step 'would' 'app' "create $AppName (this directory only, openid + profile)"
    }
} else {
    $changes = @()
    if (((@($app.web.redirectUris) | Sort-Object) -join ' ') -ne ((@($RedirectUris) | Sort-Object) -join ' ')) { $changes += 'redirect URIs' }
    if ($app.web.implicitGrantSettings.enableIdTokenIssuance -or $app.web.implicitGrantSettings.enableAccessTokenIssuance) { $changes += 'implicit grant off' }
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
    if ($app -and $PSCmdlet.ShouldProcess($AppName, 'Create enterprise app (assignment not required: anyone may sign up)')) {
        $sp = Invoke-Graph POST 'v1.0/servicePrincipals' @{ appId = $app.appId; appRoleAssignmentRequired = $false; tags = @('WindowsAzureActiveDirectoryIntegratedApp') }
        Write-Step 'created' 'enterprise' "$AppName, open to sign-up"
    } else {
        Write-Step 'would' 'enterprise' "create $AppName, open to sign-up"
    }
} else {
    Write-Step 'exists' 'enterprise' $AppName
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

# ---------------------------------------------------------------- 5. user flow

$flow = @(Get-All 'v1.0/identity/authenticationEventsFlows') | Where-Object { $_.displayName -eq $FlowName } | Select-Object -First 1
if (-not $flow) {
    if ($sp -and $PSCmdlet.ShouldProcess($FlowName, 'Create user flow (email one-time passcode, sign-up allowed) with the app linked')) {
        $flow = Invoke-Graph POST 'v1.0/identity/authenticationEventsFlows' (New-FlowBody $app.appId)
        Write-Step 'created' 'user flow' "$FlowName (email one-time passcode only, app linked)"
    } else {
        Write-Step 'would' 'user flow' "create $FlowName (email one-time passcode only, app linked)"
    }
} else {
    $providers = @(@($flow.onAuthenticationMethodLoadStart.identityProviders) | ForEach-Object { $_.id })
    if (($providers -join ' ') -ne $EmailOtp) { Write-Warning "$FlowName signs in with: $($providers -join ', '). Expected $EmailOtp only: check it in the admin centre (left alone)." }
    if (-not $flow.onInteractiveAuthFlowStart.isSignUpAllowed) { Write-Warning "$FlowName doesn't allow sign-up (left alone)." }
    Write-Step 'exists' 'user flow' $FlowName
    if ($app) {
        $linked = @(Get-All "v1.0/identity/authenticationEventsFlows/$($flow.id)/conditions/applications/includeApplications") | Where-Object { $_.appId -eq $app.appId }
        if ($linked) {
            Write-Step 'exists' 'link' "$AppName is in $FlowName"
        } elseif ($PSCmdlet.ShouldProcess($FlowName, "Link $AppName")) {
            Invoke-Graph POST "v1.0/identity/authenticationEventsFlows/$($flow.id)/conditions/applications/includeApplications" @{ '@odata.type' = '#microsoft.graph.authenticationConditionApplication'; appId = $app.appId } | Out-Null
            Write-Step 'linked' 'link' "$AppName to $FlowName"
        } else {
            Write-Step 'would' 'link' "$AppName to $FlowName"
        }
    }
}

# ---------------------------------------------------------------- 6. .dev.vars

if ($WriteDevVars) {
    $devVars = Join-Path $RepoRoot '.dev.vars'
    if (-not $app -or -not $cert -or -not (Test-Path $keyPath)) {
        Write-Step 'would' '.dev.vars' 'write client ID, thumbprint and private key (after the app exists)'
    } elseif ($PSCmdlet.ShouldProcess($devVars, 'Write customer sign-in values')) {
        $text = if (Test-Path $devVars) { [IO.File]::ReadAllText($devVars) } else { [IO.File]::ReadAllText((Join-Path $RepoRoot '.dev.vars.example')) }
        $text = Set-DotEnvValues $text ([ordered]@{
            ENTRA_CUSTOMER_TENANT_ID        = $TenantId
            ENTRA_CUSTOMER_CLIENT_ID        = $app.appId
            ENTRA_CUSTOMER_CERT_THUMBPRINT  = $cert.Thumbprint
            ENTRA_CUSTOMER_CERT_PRIVATE_KEY = ConvertTo-DotEnvPem ([IO.File]::ReadAllText($keyPath))
        })
        [IO.File]::WriteAllText($devVars, $text, (New-Object System.Text.UTF8Encoding $false))
        Write-Step 'written' '.dev.vars' 'tenant ID, client ID, thumbprint, private key (values not shown)'
    }
}

# ---------------------------------------------------------------- done

$logPath = Join-Path $logDir "setup-customer-app-$stamp.csv"
$log | Export-Csv $logPath -NoTypeInformation -Encoding UTF8
Write-Host ''
Write-Host "Log: $logPath"
if (-not $WhatIfPreference) {
    Write-Host 'Next: record it in the hub CR-002 log and docs/secrets-inventory.md (certificate expiry date).'
}
Disconnect-MgGraph | Out-Null

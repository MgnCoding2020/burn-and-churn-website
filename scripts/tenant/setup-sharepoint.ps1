<#
.SYNOPSIS
    Creates the SharePoint site /sites/bc-operations and the six lists the website reads,
    from docs/contracts/sharepoint-lists.json. Optionally seeds them.

.DESCRIPTION
    Trial day 1 (plan §3.2, §5; docs/tenant-setup.md). Needs SharePoint, so the Microsoft
    365 Business Premium trial must be running. Runs on Windows PowerShell 5.1 with only
    the Microsoft.Graph.Authentication module (Invoke-MgGraphRequest); no PnP.

      1. Site     Finds /sites/bc-operations, or creates it as a communication site
                  (Graph beta POST /sites, checked 2026-11-10) owned by the signed-in
                  account, and waits for it.
      2. Lists    Creates each missing list with its columns (internal names from the
                  contract), then gives it its display name. For an existing list, adds
                  missing columns and reports any column whose type differs, changing
                  nothing else.
      3. Seed     With -Seed, fills empty lists only: Menu from seed/menu.json (through
                  scripts/tenant/menu-seed-rows.mjs, so it matches today's site), Store
                  Hours and Inventory from the contract. A list with rows is left alone.

    What Graph can't do, the runbook does by hand: give the grp-bc- groups their permissions
    on the site and lists (docs/tenant-setup.md, step 5), with screenshots as evidence.

    Safe to run more than once. -WhatIf signs in read-only and lists every change without
    making it. Log: scripts/tenant/logs/ (git-ignored); it holds IDs and URLs, no secrets.

.PARAMETER Seed
    Fill empty lists with their starting rows.

.EXAMPLE
    .\scripts\tenant\setup-sharepoint.ps1 -WhatIf
.EXAMPLE
    .\scripts\tenant\setup-sharepoint.ps1 -Seed
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Seed
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ContractPath = Join-Path $RepoRoot 'docs\contracts\sharepoint-lists.json'

# ---------------------------------------------------------------- helpers (no Graph calls)

# One contract column -> a Graph columnDefinition
function ConvertTo-GraphColumn($Column) {
    $def = [ordered]@{ name = $Column.name; displayName = $Column.displayName }
    if ($Column.required) { $def.required = $true }
    if ($Column.unique) { $def.enforceUniqueValues = $true; $def.indexed = $true }
    switch ($Column.type) {
        'text'     { $def.text = [ordered]@{ allowMultipleLines = $false; maxLength = [int]$Column.maxLength } }
        'note'     { $def.text = [ordered]@{ allowMultipleLines = $true; textType = 'plain'; linesForEditing = 6 } }
        'choice'   { $def.choice = [ordered]@{ allowTextEntry = $false; displayAs = 'dropDownMenu'; choices = @($Column.choices) } }
        'currency' { $def.currency = [ordered]@{ locale = 'en-us' } }
        'number'   { $def.number = [ordered]@{ minimum = [double]$Column.min; maximum = [double]$Column.max; decimalPlaces = 'none'; displayAs = 'number' } }
        'boolean'  { $def.boolean = @{} }
        'date'     { $def.dateTime = [ordered]@{ format = 'dateOnly'; displayAs = 'default' } }
        'person'   { $def.personOrGroup = [ordered]@{ allowMultipleSelection = $false; chooseFromType = 'peopleOnly' } }
        default    { throw "Unknown column type '$($Column.type)' on $($Column.name)." }
    }
    return $def
}

# The Graph facet name a column of this contract type should have
function Get-GraphFacet([string]$Type) {
    switch ($Type) {
        'note' { 'text' } 'date' { 'dateTime' } 'person' { 'personOrGroup' } default { $Type }
    }
}

# Dot-sourcing (tests) loads the helpers above and stops here
if ($MyInvocation.InvocationName -eq '.') { return }

# ---------------------------------------------------------------- inputs

$contract = Get-Content $ContractPath -Raw | ConvertFrom-Json
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = New-Object System.Collections.Generic.List[object]
function Write-Step($Action, $Object, $Detail) {
    $log.Add([pscustomobject]@{ timestamp = (Get-Date -Format 's'); action = $Action; object = $Object; detail = $Detail })
    Write-Host ("  {0,-10} {1} {2}" -f $Action, $Object, $Detail)
}
$mode = if ($WhatIfPreference) { 'WHAT IF: nothing is changed' } else { 'changes are made' }
Write-Host "SharePoint set-up for $($contract.site.path) ($mode)"

# ---------------------------------------------------------------- sign in

$scopes = if ($WhatIfPreference) { @('Sites.Read.All') } else { @('Sites.Manage.All', 'Sites.Create.All') }
Connect-MgGraph -Scopes $scopes -NoWelcome
$account = (Get-MgContext).Account
function Invoke-Graph([string]$Method, [string]$Uri, $Body) {
    $request = @{ Method = $Method; Uri = $Uri; OutputType = 'PSObject' }
    if ($null -ne $Body) { $request.Body = ($Body | ConvertTo-Json -Depth 10); $request.ContentType = 'application/json' }
    Invoke-MgGraphRequest @request
}

# ---------------------------------------------------------------- 1. site

$hostname = (Invoke-Graph GET 'https://graph.microsoft.com/v1.0/sites/root?$select=siteCollection').siteCollection.hostname
$siteUrl = "https://$hostname$($contract.site.path)"
$site = $null
try {
    $site = Invoke-Graph GET "https://graph.microsoft.com/v1.0/sites/${hostname}:$($contract.site.path)?`$select=id,webUrl,displayName"
    Write-Step 'exists' 'site' $site.webUrl
} catch {
    if ($_.Exception.Message -notmatch '404|NotFound|itemNotFound') { throw }
}

if (-not $site) {
    if ($PSCmdlet.ShouldProcess($siteUrl, "Create communication site '$($contract.site.title)' owned by $account")) {
        $body = [ordered]@{
            name = $contract.site.title
            webUrl = $siteUrl
            description = $contract.site.description
            locale = 'en-US'
            shareByEmailEnabled = $false
            template = $contract.site.template
            ownerIdentityToResolve = @{ email = $account }
        }
        # Beta endpoint; returns 202 and a Location to poll.
        $resp = Invoke-MgGraphRequest -Method POST -Uri 'https://graph.microsoft.com/beta/sites' `
            -Body ($body | ConvertTo-Json -Depth 5) -ContentType 'application/json' -OutputType HttpResponseMessage
        $status = $resp.Headers.Location.AbsoluteUri
        Write-Step 'creating' 'site' "$siteUrl (waiting)"
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 5
            try {
                $site = Invoke-Graph GET "https://graph.microsoft.com/v1.0/sites/${hostname}:$($contract.site.path)?`$select=id,webUrl,displayName"
                break
            } catch {
                if ($status) {
                    $op = Invoke-Graph GET $status
                    if ($op.status -eq 'failed') { throw "Site creation failed: $($op.error.message)" }
                }
            }
        }
        if (-not $site) { throw "The site wasn't ready after 5 minutes. Run the script again; it will find it." }
        Write-Step 'created' 'site' $site.webUrl
    } else {
        Write-Step 'would' 'site' "create $siteUrl (communication site, owner $account)"
    }
}

# ---------------------------------------------------------------- 2. lists and 3. seed

$record = [ordered]@{ at = (Get-Date -Format 's'); whatIf = [bool]$WhatIfPreference; siteUrl = $siteUrl; siteId = $site.id; lists = [ordered]@{} }

if ($site) {
    $existing = (Invoke-Graph GET "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists?`$select=id,name,displayName&`$top=200").value
}

foreach ($list in $contract.lists) {
    $found = if ($site) { $existing | Where-Object { $_.name -eq $list.name } | Select-Object -First 1 }
    if (-not $found) {
        $columns = @($list.columns | ForEach-Object { ConvertTo-GraphColumn $_ })
        if ($site -and $PSCmdlet.ShouldProcess("$siteUrl/Lists/$($list.name)", "Create list with $($columns.Count) columns")) {
            $found = Invoke-Graph POST "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists" ([ordered]@{
                displayName = $list.name; list = @{ template = 'genericList' }; columns = $columns
            })
            if ($list.displayName -ne $list.name) {
                Invoke-Graph PATCH "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists/$($found.id)" @{ displayName = $list.displayName } | Out-Null
            }
            Write-Step 'created' "list $($list.name)" "$($columns.Count) columns"
        } else {
            Write-Step 'would' "list $($list.name)" "create with $($columns.Count) columns: $(($list.columns | ForEach-Object name) -join ', ')"
            continue
        }
    } else {
        Write-Step 'exists' "list $($list.name)" $found.id
        $have = (Invoke-Graph GET "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists/$($found.id)/columns?`$top=200").value
        foreach ($column in $list.columns) {
            $match = $have | Where-Object { $_.name -eq $column.name } | Select-Object -First 1
            $facet = Get-GraphFacet $column.type
            if (-not $match) {
                if ($PSCmdlet.ShouldProcess("$($list.name).$($column.name)", 'Add column')) {
                    Invoke-Graph POST "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists/$($found.id)/columns" (ConvertTo-GraphColumn $column) | Out-Null
                    Write-Step 'added' "$($list.name).$($column.name)" $column.type
                } else {
                    Write-Step 'would' "$($list.name).$($column.name)" "add ($($column.type))"
                }
            } elseif (-not $match.PSObject.Properties[$facet]) {
                Write-Step 'MISMATCH' "$($list.name).$($column.name)" "isn't a $($column.type) column; not changed (fix by hand, see the contract)"
            }
        }
    }

    # The Title column's display name ("Drink", "Day", ...)
    $titleColumn = (Invoke-Graph GET "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists/$($found.id)/columns?`$top=200").value |
        Where-Object { $_.name -eq 'Title' } | Select-Object -First 1
    if ($titleColumn -and $titleColumn.displayName -ne $list.title.displayName) {
        if ($PSCmdlet.ShouldProcess("$($list.name).Title", "Show as '$($list.title.displayName)'")) {
            Invoke-Graph PATCH "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists/$($found.id)/columns/$($titleColumn.id)" @{ displayName = $list.title.displayName } | Out-Null
            Write-Step 'renamed' "$($list.name).Title" $list.title.displayName
        }
    }
    $record.lists[$list.name] = $found.id

    if (-not $Seed) { continue }
    $rows = $null
    if ($list.seed) {
        $json = & node (Join-Path $PSScriptRoot 'menu-seed-rows.mjs')
        if ($LASTEXITCODE) { throw 'menu-seed-rows.mjs failed (is Node installed?).' }
        $rows = ($json -join "`n") | ConvertFrom-Json
    } elseif ($list.seedRows) {
        $rows = $list.seedRows
    }
    if (-not $rows) { continue }
    $count = @((Invoke-Graph GET "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists/$($found.id)/items?`$top=1").value).Count
    if ($count -gt 0) { Write-Step 'skipped' "seed $($list.name)" 'the list already has rows'; continue }
    if ($PSCmdlet.ShouldProcess($list.name, "Add $(@($rows).Count) starting rows")) {
        foreach ($row in $rows) {
            $fields = [ordered]@{}
            foreach ($p in $row.PSObject.Properties) { $fields[$p.Name] = $p.Value }
            Invoke-Graph POST "https://graph.microsoft.com/v1.0/sites/$($site.id)/lists/$($found.id)/items" @{ fields = $fields } | Out-Null
        }
        Write-Step 'seeded' $list.name "$(@($rows).Count) rows"
    } else {
        Write-Step 'would' "seed $($list.name)" "$(@($rows).Count) rows"
    }
}

# ---------------------------------------------------------------- record

$logFile = Join-Path $logDir "setup-sharepoint-$stamp.json"
[ordered]@{ record = $record; steps = $log } | ConvertTo-Json -Depth 6 | Set-Content -Path $logFile -Encoding utf8
Write-Host ''
Write-Host "Site: $siteUrl"
Write-Host "Log:  $logFile"
Write-Host 'Next: give the grp-bc- groups their permissions by hand (docs/tenant-setup.md, step 5),'
Write-Host '      then run setup-sync-app.ps1 to grant the website read on its lists.'

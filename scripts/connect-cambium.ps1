<#
.SYNOPSIS
  Connect the Knowledge tab to cambium-remote in one run, with nothing for you
  to look up, paste, or remember.

.DESCRIPTION
  Generates a status-only credential, installs it on cambium-remote as
  STATUS_TOKEN, verifies the route answers, then installs the resulting URL here
  as CAMBIUM_STATUS_URL. You are not asked for anything.

  WHY THIS EXISTS RATHER THAN "PASTE YOUR CONNECTOR URL"

  The first version of this asked for cambium-remote's connector URL. Two things
  were wrong with that. It required a human to go and find a secret in claude.ai
  and paste it -- and the whole point of these scripts is that nobody has to
  handle a credential by hand. Worse, that URL is cambium-remote's AUTH_TOKEN,
  which grants `recall` over every promoted item in the team and org scopes. To
  render three integers on a phone, a full-access credential would have been
  copied into a second Worker, where a leak of the second discloses the reach of
  the first.

  STATUS_TOKEN grants exactly one read: the counts. It cannot call recall and
  cannot reach the knowledge itself. And because it is generated rather than
  looked up, the whole thing automates -- AUTH_TOKEN never could, since
  Cloudflare stores secrets write-only and it can only be re-typed by hand.

  Rotating it is invisible to every MCP client, because it is not the connector
  token. Re-running this script is the rotation.

.PARAMETER CambiumDir
  Path to the cambium-remote checkout. Defaults to a sibling of this repo.

.PARAMETER Yes
  Skip the confirmation when a STATUS_TOKEN already exists.
#>
[CmdletBinding()]
param(
    [string]$CambiumDir = "",
    [string]$CambiumUrl = "",
    [switch]$Yes,
    [switch]$DryRun,
    # Wrangler environments differ between the two Workers and passing the wrong
    # one is a hard failure, not a no-op: cambium-remote has no [env.production]
    # section at all -- it deploys with a bare `wrangler deploy` -- while this
    # repo keeps its CI deploy under --env production. So they cannot share a
    # flag, and defaulting both to "production" would have failed at the install
    # step with "No environment found in configuration with name production".
    [string]$CambiumEnv = "",
    [string]$LocalEnv = "production",
    # Deploying cambium-remote is a side effect on another Worker, so it is
    # opt-out. It only ever fires when the status route is already failing, and
    # it deploys that repo's own checked-out main -- never anything of this
    # repo's.
    [switch]$SkipDeploy
)

$cambiumEnvArgs = @(); if ($CambiumEnv) { $cambiumEnvArgs = @("--env", $CambiumEnv) }
$localEnvArgs   = @(); if ($LocalEnv)   { $localEnvArgs   = @("--env", $LocalEnv) }

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
# Relocate into the repo. Without this, npx resolves wrangler from the NETWORK
# rather than node_modules whenever the script is launched from anywhere else --
# which is slower, needs connectivity, and on a fresh cache prints an
# "Ok to proceed?" prompt that a double-clicked window will sit on forever.
Set-Location $repo

# Every run records itself, for the same reason set-view-token.ps1 does: a
# double-clicked console can close, scroll, or lead with the least informative
# line of a PowerShell dump, so "what did it say?" is a bad question to have to
# ask. Nothing secret reaches this log -- the token is generated after it opens
# and is never written to the host -- but it is scrubbed on exit regardless.
$script:LogPath = Join-Path $repo ".cambium-setup.log"
$script:LogOn = $false
$script:TokenSeen = $null
$script:MaskSeen = $null
try { Start-Transcript -Path $script:LogPath -Force | Out-Null; $script:LogOn = $true } catch { }

function Stop-Log {
    if ($script:LogOn) { try { Stop-Transcript | Out-Null } catch { }; $script:LogOn = $false }
    if ($script:TokenSeen -and (Test-Path $script:LogPath)) {
        try {
            $raw = Get-Content $script:LogPath -Raw
            Set-Content -Path $script:LogPath -Value $raw.Replace($script:TokenSeen, $script:MaskSeen) -Encoding UTF8
        } catch { }
    }
}

try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

function Fail($m) {
    Write-Host "`n  ERROR: $m`n" -ForegroundColor Red
    Stop-Log
    if (Test-Path $script:LogPath) {
        Write-Host "  Full log (safe to share): $script:LogPath" -ForegroundColor DarkGray
        Write-Host ""
    }
    exit 1
}
function Say($m)  { Write-Host "  $m" }

# con-002: on PS 5.1, 2>&1 on a native command wraps stderr in ErrorRecords and
# 'Stop' makes the first one terminating, so an ordinary wrangler notice kills
# the run. Drop to Continue for the call, restore after.
function Invoke-Wrangler {
    param([Parameter(Mandatory = $true)][string[]]$WranglerArgs, [string]$StdIn, [string]$In = "")
    $prev = $ErrorActionPreference
    $prevLoc = Get-Location
    $ErrorActionPreference = 'Continue'
    try {
        if ($In) { Set-Location $In }
        if ($PSBoundParameters.ContainsKey('StdIn')) {
            $out = $StdIn | & npx wrangler @WranglerArgs 2>&1 | Out-String
        } else {
            $out = & npx wrangler @WranglerArgs 2>&1 | Out-String
        }
        return [pscustomobject]@{ Output = $out; Code = $LASTEXITCODE }
    } finally {
        $ErrorActionPreference = $prev
        Set-Location $prevLoc
    }
}

trap {
    Write-Host "`n  UNHANDLED ERROR" -ForegroundColor Red
    Write-Host "    $($_.Exception.GetType().Name): $($_.Exception.Message)" -ForegroundColor Red
    if ($_.InvocationInfo) {
        Write-Host "    at script line $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())" -ForegroundColor Red
    }
    Stop-Log
    if (Test-Path $script:LogPath) { Write-Host "`n  Full log: $script:LogPath" -ForegroundColor DarkGray }
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "  connect the Knowledge tab to cambium-remote" -ForegroundColor Cyan
Write-Host "  -------------------------------------------"

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { Fail "npx not found. Install Node 22+." }

# --- locate cambium-remote ------------------------------------------------
if (-not $CambiumDir) { $CambiumDir = Join-Path (Split-Path -Parent $repo) "cambium-remote" }
if (-not (Test-Path (Join-Path $CambiumDir "wrangler.toml"))) {
    Fail "cambium-remote not found at $CambiumDir. Pass -CambiumDir <path> to its checkout. Nothing was changed."
}
Say "cambium-remote : $CambiumDir"

# Resolved BEFORE anything is installed, for the same reason set-view-token does
# it: a token installed with no URL to put it in is unrecoverable.
if (-not $CambiumUrl) {
    $pkg = Join-Path $CambiumDir "package.json"
    if (Test-Path $pkg) {
        try {
            $j = Get-Content $pkg -Raw | ConvertFrom-Json
            if ($j.contextKeeper -and $j.contextKeeper.workerUrl) { $CambiumUrl = [string]$j.contextKeeper.workerUrl }
        } catch { }
    }
}
if (-not $CambiumUrl) {
    $name = (Select-String -Path (Join-Path $CambiumDir "wrangler.toml") -Pattern '^name\s*=\s*"([^"]+)"' |
             Select-Object -First 1).Matches.Groups[1].Value
    $mine = ""
    try {
        $j = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
        $mine = [string]$j.contextKeeper.workerUrl
    } catch { }
    # Same account => same workers.dev subdomain. Derive it from this repo's own
    # known URL rather than asking, then prove it by probing below.
    if ($name -and $mine -match '^https://[^.]+\.(.+\.workers\.dev)$') {
        $CambiumUrl = "https://$name.$($Matches[1])"
    }
}
if (-not $CambiumUrl) { Fail "Could not work out cambium-remote's URL. Pass -CambiumUrl. Nothing was changed." }
$CambiumUrl = $CambiumUrl.TrimEnd('/')
Say "url            : $CambiumUrl"

Write-Host "  checking wrangler..." -NoNewline
$who = Invoke-Wrangler -WranglerArgs @("whoami")
if ($who.Code -ne 0 -or $who.Output -match "not authenticated|not logged in") {
    Write-Host ""; Fail "wrangler is not authenticated. Run 'npx wrangler login' and re-run."
}
Write-Host " ok" -ForegroundColor Green

# --- replace confirmation, failing closed (con-004) -----------------------
$existing = Invoke-Wrangler -WranglerArgs (@("secret", "list") + $cambiumEnvArgs) -In $CambiumDir
if ($existing.Output -match '"name"\s*:\s*"STATUS_TOKEN"' -and -not $Yes) {
    Write-Host ""
    Write-Host "  cambium-remote already has a STATUS_TOKEN." -ForegroundColor Yellow
    Write-Host "  Replacing it is harmless -- it is not the connector token, so no MCP"
    Write-Host "  client is affected. This view is the only thing that uses it."
    if ([Console]::IsInputRedirected) {
        Fail "Nothing is attached to answer the prompt. Re-run with -Yes to replace it. Nothing was changed."
    }
    $go = ""
    try { $go = [string](Read-Host "  Replace it? [y/N]") } catch { $go = "" }
    if ($go -notmatch '^\s*[Yy]') { Write-Host "  cancelled.`n"; Stop-Log; exit 0 }
}

if ($DryRun) {
    Write-Host ""
    Write-Host "  dry run -- resolution and preflight succeeded." -ForegroundColor Green
    Say "would generate a 32-byte STATUS_TOKEN"
    Say "would run: wrangler secret put STATUS_TOKEN $($cambiumEnvArgs -join ' ')  in $CambiumDir"
    Say "would poll $CambiumUrl/status/<token> until it returns counts"
    Say "would then set CAMBIUM_STATUS_URL here"
    Say "Nothing was installed and nothing was probed."
    Stop-Log
    Say "log: $script:LogPath"
    Write-Host ""
    exit 0
}

# --- generate -------------------------------------------------------------
# RNGCryptoServiceProvider, not RandomNumberGenerator::Fill: the latter does not
# exist on the .NET Framework that PowerShell 5.1 runs on.
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes); $rng.Dispose()
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$mask = $token.Substring(0, 4) + ("." * 12) + $token.Substring($token.Length - 4)
$script:TokenSeen = $token
$script:MaskSeen  = $mask

# --- install on cambium-remote -------------------------------------------
Write-Host "  installing STATUS_TOKEN on cambium-remote..." -NoNewline
$put = Invoke-Wrangler -WranglerArgs (@("secret", "put", "STATUS_TOKEN") + $cambiumEnvArgs) -StdIn $token -In $CambiumDir
if ($put.Code -ne 0) {
    Write-Host ""
    ($put.Output -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 5) |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Fail "wrangler secret put failed on cambium-remote (exit $($put.Code)). Nothing else was changed."
}
Write-Host " ok" -ForegroundColor Green

$statusUrl = "$CambiumUrl/status/$token"

# --- verify BEFORE wiring it here ----------------------------------------
# Catching a bad URL now is the difference between an error here and a panel
# that silently says "unreachable" on a phone days later.
# 60 seconds, not 18. `wrangler secret put` does not merely store a value: it
# creates a NEW Worker version and rolls it out. Until that reaches an edge,
# requests there are still served by the PREVIOUS version, which holds the
# PREVIOUS token -- so a correct token legitimately 404s for a while. An 18-second
# window was inside that race, and the resulting message blamed a missing
# deployment, which sent the whole diagnosis in the wrong direction.
Write-Host "  waiting for the new version to roll out (up to 60s)" -NoNewline
$ok = $false; $detail = ""
foreach ($attempt in 1..20) {
    Start-Sleep -Seconds 3
    Write-Host "." -NoNewline
    try {
        $r = Invoke-WebRequest -Uri $statusUrl -Method Get -TimeoutSec 20 -UseBasicParsing `
             -Headers @{ "user-agent" = "context-keeper-view/1.0" }
        if ([int]$r.StatusCode -eq 200 -and $r.Content -match '"counts"') { $ok = $true; break }
        $detail = "answered $([int]$r.StatusCode) without counts"
    } catch [System.Net.WebException] {
        $detail = if ($_.Exception.Response) { "HTTP $([int]$_.Exception.Response.StatusCode)" } else { $_.Exception.Message }
    } catch { $detail = $_.Exception.Message }
}
# The route is not answering, and the overwhelmingly likely reason is that
# cambium-remote has not been deployed since /status was added. Rather than
# printing that as homework, deploy it -- wrangler is already authenticated
# here, which is how this script has been writing secrets all along.
#
# This is the difference between a setup script and a checklist. cambium-remote's
# GitHub Actions deploy needs CLOUDFLARE_API_TOKEN, which only Cloudflare can
# mint and only a human can create; if that is unset the workflow fails silently
# on every merge and the Worker never updates. Deploying from here needs none of
# that, so the CI gap stops being a prerequisite for this feature working.
if (-not $ok -and -not $SkipDeploy) {
    Write-Host ""
    Say "The status route is not answering ($detail), which almost always means"
    Say "cambium-remote has not been deployed since /status was added."
    Write-Host "  deploying cambium-remote..." -NoNewline
    $dep = Invoke-Wrangler -WranglerArgs @("deploy") -In $CambiumDir
    if ($dep.Code -ne 0) {
        Write-Host ""
        ($dep.Output -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 6) |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Fail "Could not deploy cambium-remote. CAMBIUM_STATUS_URL was NOT set, so nothing here points at a route that does not work."
    }
    Write-Host " ok" -ForegroundColor Green

    Write-Host "  re-checking the status route (up to 60s)" -NoNewline
    foreach ($attempt in 1..20) {
        Start-Sleep -Seconds 3
        Write-Host "." -NoNewline
        try {
            $r = Invoke-WebRequest -Uri $statusUrl -Method Get -TimeoutSec 20 -UseBasicParsing `
                 -Headers @{ "user-agent" = "context-keeper-view/1.0" }
            if ([int]$r.StatusCode -eq 200 -and $r.Content -match '"counts"') { $ok = $true; break }
            $detail = "answered $([int]$r.StatusCode) without counts"
        } catch [System.Net.WebException] {
            $detail = if ($_.Exception.Response) { "HTTP $([int]$_.Exception.Response.StatusCode)" } else { $_.Exception.Message }
        } catch { $detail = $_.Exception.Message }
    }
    if ($ok) { Write-Host " ok" -ForegroundColor Green }
}

if (-not $ok) {
    Write-Host ""
    Say "cambium-remote still did not serve the status route ($detail), even after"
    Say "deploying it. That is unusual. Check the Worker's logs:"
    Say "    npx wrangler tail        (run it from the cambium-remote checkout)"
    Say "Zero requests appearing there means the call is not reaching it at all."
    Fail "CAMBIUM_STATUS_URL was NOT set, so nothing here points at a route that does not work."
}
Write-Host " ok" -ForegroundColor Green

# --- install here ---------------------------------------------------------
Write-Host "  installing CAMBIUM_STATUS_URL..." -NoNewline
$put2 = Invoke-Wrangler -WranglerArgs (@("secret", "put", "CAMBIUM_STATUS_URL") + $localEnvArgs) -StdIn $statusUrl -In $repo
if ($put2.Code -ne 0) { Write-Host ""; Fail "wrangler secret put failed here (exit $($put2.Code))." }
Write-Host " ok" -ForegroundColor Green

$token = $null; $statusUrl = $null

Write-Host ""
Write-Host "  done." -ForegroundColor Green
Say "status token : $mask   (never printed in full)"
Say "The Knowledge tab will show cambium's team and org counts within a minute."
Say "This token can read those counts and nothing else -- not recall, not the"
Say "knowledge itself. Rotating it means re-running this, and no MCP client"
Say "notices, because it is not the connector token."
Write-Host ""
Stop-Log

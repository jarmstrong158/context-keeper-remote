<#
.SYNOPSIS
  Generate a VIEW_TOKEN, set it on the Worker, and hand you the view URL --
  without the value ever being printed, logged, or passed as an argument.

.DESCRIPTION
  The view URL is a credential. This project's own README documents connector
  URLs turning up in ~54 places across 13 local session transcripts on a single
  machine, and the usual ways of setting a secret are exactly how that happens:

    wrangler secret put VIEW_TOKEN abc123     <- shell history, process list
    echo abc123 | wrangler secret put ...     <- shell history
    "here is your token: abc123"              <- terminal scrollback, screenshots,
                                                 and any agent transcript watching

  So this script never does any of those. The token is generated in-process from
  the OS CSPRNG, written to wrangler's STDIN (never argv, so it cannot appear in
  the process list), copied to your clipboard for the password manager, and
  shown only as a mask. Nothing that survives the run contains it except
  Cloudflare and your clipboard.

.PARAMETER Env
  Wrangler environment. "production" for this repo's own Worker (the default);
  omit for a self-hosted deploy that uses the top-level config.

.PARAMETER Rotate
  Skip the confirmation prompt when replacing an existing token. Rotating
  invalidates every existing view URL immediately; it does NOT touch AUTH_TOKEN,
  so MCP connectors are unaffected.

.EXAMPLE
  .\scripts\set-view-token.ps1
.EXAMPLE
  .\scripts\set-view-token.ps1 -Env "" -WorkerUrl https://my-worker.me.workers.dev
#>
[CmdletBinding()]
param(
    [string]$Env = "production",
    [string]$WorkerUrl = "",
    [switch]$Rotate
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($msg) { Write-Host "`n  ERROR: $msg`n" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  context-keeper-remote : view token setup" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

# --- preflight ------------------------------------------------------------
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Fail "npx not found. Install Node 22+ and re-run."
}
Write-Host "  checking wrangler auth..." -NoNewline
$who = & npx wrangler whoami 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $who -match "not authenticated|You are not logged in") {
    Write-Host ""
    Fail "wrangler is not authenticated. Run 'npx wrangler login' and re-run."
}
Write-Host " ok" -ForegroundColor Green

if (-not $Rotate) {
    Write-Host ""
    Write-Host "  This sets VIEW_TOKEN. If one already exists it is REPLACED and"
    Write-Host "  every existing view URL stops working immediately."
    Write-Host "  AUTH_TOKEN is untouched, so MCP connectors keep working."
    $go = Read-Host "  Continue? [y/N]"
    if ($go -notmatch '^[Yy]') { Write-Host "  cancelled.`n"; exit 0 }
}

# --- generate -------------------------------------------------------------
# 32 bytes from the OS CSPRNG, base64url so it is safe in a path segment.
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

# --- set ------------------------------------------------------------------
# Via STDIN, not argv: an argument would be visible in the process list to any
# other user on the machine for the lifetime of the call.
Write-Host "  setting VIEW_TOKEN..." -NoNewline
$envArgs = @()
if ($Env) { $envArgs = @("--env", $Env) }
$token | & npx wrangler secret put VIEW_TOKEN @envArgs 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Fail "wrangler secret put failed. Run it manually to see the error:`n         npx wrangler secret put VIEW_TOKEN $($envArgs -join ' ')"
}
Write-Host " ok" -ForegroundColor Green

# --- resolve the worker URL ----------------------------------------------
if (-not $WorkerUrl) {
    $dep = & npx wrangler deployments list @envArgs 2>&1 | Out-String
    if ($dep -match '(https://[a-z0-9.\-]+\.workers\.dev)') { $WorkerUrl = $Matches[1] }
}
if (-not $WorkerUrl) {
    $WorkerUrl = "https://<your-worker>.workers.dev"
    Write-Host "  (could not detect the Worker URL; substitute it below)" -ForegroundColor Yellow
}
$viewUrl = "$($WorkerUrl.TrimEnd('/'))/view/$token"

# --- hand it over ---------------------------------------------------------
try {
    Set-Clipboard -Value $viewUrl
    $clip = $true
} catch { $clip = $false }

$mask = $token.Substring(0, 4) + ("." * 12) + $token.Substring($token.Length - 4)

Write-Host ""
Write-Host "  done." -ForegroundColor Green
Write-Host "  token   : $mask   (32 bytes, never printed in full)"
Write-Host "  url     : $($WorkerUrl.TrimEnd('/'))/view/$mask"
if ($clip) {
    Write-Host "  clipboard: the FULL url is on your clipboard right now" -ForegroundColor Cyan
} else {
    Write-Host "  clipboard unavailable -- retrieve the token from Cloudflare is NOT" -ForegroundColor Yellow
    Write-Host "  possible; re-run this script to generate a new one." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  NEXT:"
Write-Host "    1. Paste it into your password manager NOW. Cloudflare stores"
Write-Host "       secrets write-only -- you cannot read it back, only replace it."
Write-Host "    2. Open it on your phone and Add to Home Screen."
Write-Host ""
Write-Host "  Treat that URL like a password. It is read-only (it can never write"
Write-Host "  to a store) but anyone holding it can read every decision summary."
Write-Host ""

# --- verify ---------------------------------------------------------------
# Proves the secret actually took effect, without printing the token. Cloudflare
# takes a moment to propagate a new secret, so this retries briefly.
Write-Host "  verifying..." -NoNewline
$ok = $false
foreach ($i in 1..6) {
    Start-Sleep -Seconds 3
    try {
        $r = Invoke-WebRequest -Uri $viewUrl -Method Head -TimeoutSec 15 -SkipHttpErrorCheck
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}
if ($ok) {
    Write-Host " live (HTTP 200)" -ForegroundColor Green
} else {
    Write-Host " not answering yet" -ForegroundColor Yellow
    Write-Host "  The secret is set; propagation can take a minute. If it still 404s"
    Write-Host "  after that, confirm the Worker was deployed with the /view route."
}
Write-Host ""

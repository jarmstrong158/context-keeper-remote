<#
.SYNOPSIS
  One shot: generate a VIEW_TOKEN, install it, verify the route, and open the
  phone view -- without the token being printed, logged, or passed as an argument.

.DESCRIPTION
  Run it and you are done. On a fresh setup it asks nothing: it generates the
  token, installs it, waits for the route to answer 200, puts the URL on your
  clipboard, and opens it in your browser so it lands in history where you can
  bookmark it or send it to your phone. The only prompt it will ever show is a
  confirmation when a VIEW_TOKEN already exists, because replacing one silently
  breaks every URL already in use -- and -Yes skips even that.

  The view URL is a credential, and every ordinary way of setting one leaks it:

    wrangler secret put VIEW_TOKEN <value>   argv -> shell history AND the
                                             process list, readable by any other
                                             user for the duration of the call
    echo <value> | wrangler secret put ...   shell history
    printing it for you to copy              scrollback, screen-shares,
                                             screenshots, and the transcript of
                                             any coding agent that ran it

  That last one is measured, not theoretical: this repo's README documents
  connector URLs found in ~54 occurrences across 13 local session transcripts on
  a single machine, none pasted deliberately. So the token here is generated
  in-process, written to wrangler's STDIN (never argv, so it never reaches the
  process list), and displayed only as a mask. It lands in exactly two places:
  Cloudflare, and your clipboard.

  Targets Windows PowerShell 5.1, which is what the .cmd wrapper launches and
  what ships with Windows. RNGCryptoServiceProvider and the WebException status
  handling below are deliberate 5.1 choices -- RandomNumberGenerator::Fill and
  -SkipHttpErrorCheck are .NET Core / PowerShell 7 only and throw here.

.PARAMETER WranglerEnv
  Wrangler environment. "production" for this repo's Worker (the default); pass
  "" for a self-hosted deploy that uses the top-level config.

.PARAMETER Yes
  Skip the replace-confirmation. Rotating invalidates every existing view URL
  immediately. AUTH_TOKEN is never touched, so MCP connectors keep working.

.PARAMETER NoBrowser
  Do not open the view when it comes up.

.EXAMPLE
  .\scripts\set-view-token.ps1
.EXAMPLE
  .\scripts\set-view-token.ps1 -WranglerEnv "" -WorkerUrl https://my-worker.me.workers.dev
#>
[CmdletBinding()]
param(
    [string]$WranglerEnv = "production",
    [string]$WorkerUrl = "",
    [switch]$Yes,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

# Some 5.1 installs still default to TLS 1.0, which workers.dev refuses. Without
# this the verification step fails with a connection error that looks like the
# secret did not take.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

function Fail($msg) { Write-Host "`n  ERROR: $msg`n" -ForegroundColor Red; exit 1 }
function Say($msg)  { Write-Host "  $msg" }

Write-Host ""
Write-Host "  context-keeper-remote : view token setup" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

$envArgs = @()
if ($WranglerEnv) { $envArgs = @("--env", $WranglerEnv) }

# --- preflight ------------------------------------------------------------
# Checked separately so an auth problem reports as an auth problem, instead of
# surfacing later as an opaque "secret put failed".
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Fail "npx not found. Install Node 22+ and re-run."
}
Write-Host "  checking wrangler..." -NoNewline
$who = & npx wrangler whoami 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $who -match "not authenticated|You are not logged in") {
    Write-Host ""
    Fail "wrangler is not authenticated. Run 'npx wrangler login' and re-run."
}
Write-Host " ok" -ForegroundColor Green

# --- is this a create or a replace? --------------------------------------
# Only a replace is destructive, so only a replace is worth stopping for.
$existing = $false
try {
    $list = & npx wrangler secret list @envArgs 2>&1 | Out-String
    if ($list -match '"?name"?\s*:\s*"VIEW_TOKEN"') { $existing = $true }
} catch { }

if ($existing -and -not $Yes) {
    Write-Host ""
    Write-Host "  A VIEW_TOKEN already exists." -ForegroundColor Yellow
    Write-Host "  Replacing it breaks every view URL already in use, immediately."
    Write-Host "  AUTH_TOKEN is untouched, so MCP connectors keep working."
    $go = Read-Host "  Replace it? [y/N]"
    if ($go -notmatch '^[Yy]') { Write-Host "  cancelled.`n"; exit 0 }
}

# --- generate -------------------------------------------------------------
# 32 bytes from the OS CSPRNG. RNGCryptoServiceProvider rather than
# RandomNumberGenerator::Fill, which does not exist on .NET Framework / PS 5.1.
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$rng.Dispose()
# base64url, so the value is safe as a path segment without escaping.
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$mask  = $token.Substring(0, 4) + ("." * 12) + $token.Substring($token.Length - 4)

# --- install --------------------------------------------------------------
Write-Host "  installing VIEW_TOKEN..." -NoNewline
$token | & npx wrangler secret put VIEW_TOKEN @envArgs 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Fail "wrangler secret put failed. Run it by hand to see the error:`n         npx wrangler secret put VIEW_TOKEN $($envArgs -join ' ')"
}
Write-Host " ok" -ForegroundColor Green

# --- resolve the Worker URL ----------------------------------------------
if (-not $WorkerUrl) {
    try {
        $dep = & npx wrangler deployments list @envArgs 2>&1 | Out-String
        if ($dep -match '(https://[a-z0-9.\-]+\.workers\.dev)') { $WorkerUrl = $Matches[1] }
    } catch { }
}
if (-not $WorkerUrl) {
    Write-Host ""
    Say "The secret is installed, but the Worker URL could not be detected."
    Say "Re-run with -WorkerUrl https://<your-worker>.workers.dev to get the"
    Say "full link, or find it in the Cloudflare dashboard. The token cannot be"
    Say "read back, so re-running is the only way to recover the URL."
    Write-Host ""
    exit 1
}
$viewUrl = "$($WorkerUrl.TrimEnd('/'))/view/$token"

# --- verify ---------------------------------------------------------------
# Proves the secret took effect without ever rendering it. Cloudflare needs a
# moment to propagate a new secret, so this retries rather than judging on one
# attempt. No -SkipHttpErrorCheck: that is PowerShell 7 only, and on 5.1 a 4xx
# arrives as a terminating WebException carrying the response.
Write-Host "  verifying..." -NoNewline
$code = 0
foreach ($attempt in 1..8) {
    Start-Sleep -Seconds 3
    try {
        $resp = Invoke-WebRequest -Uri $viewUrl -Method Head -TimeoutSec 15 -UseBasicParsing
        $code = [int]$resp.StatusCode
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { $code = 0 }
    } catch {
        $code = 0
    }
    if ($code -eq 200) { break }
}

if ($code -eq 200) {
    Write-Host " live (HTTP 200)" -ForegroundColor Green
} elseif ($code -eq 404) {
    Write-Host " still 404" -ForegroundColor Yellow
    Say "The secret is set, but the route is not answering. The likeliest cause"
    Say "is a Worker deployed before the /view route existed -- redeploy, then"
    Say "open the URL on your clipboard. Re-running this script is not needed."
} else {
    Write-Host " no answer (HTTP $code)" -ForegroundColor Yellow
    Say "The secret is set. Propagation can take a minute; try the URL shortly."
}

# --- hand it over ---------------------------------------------------------
$copied = $false
try { Set-Clipboard -Value $viewUrl; $copied = $true } catch { }

Write-Host ""
Write-Host "  done." -ForegroundColor Green
Say "token : $mask   (32 bytes; never printed in full)"
Say "url   : $($WorkerUrl.TrimEnd('/'))/view/$mask"
if ($copied) {
    Write-Host "  The full URL is on your clipboard." -ForegroundColor Cyan
} else {
    Write-Host "  Clipboard unavailable. The token cannot be read back from" -ForegroundColor Yellow
    Write-Host "  Cloudflare, so re-run this script to get a usable URL." -ForegroundColor Yellow
}

if (-not $NoBrowser -and $code -eq 200) {
    Say "Opening it in your browser..."
    # Also the durability story: once it is in browser history you can bookmark
    # it or push it to your phone through browser sync, so losing the clipboard
    # is not losing the URL.
    #
    # This is the one place the URL is passed as an argument, which the rest of
    # the script goes out of its way to avoid. It is unavoidable -- there is no
    # way to hand a URL to a browser over stdin -- and it is a smaller exposure
    # than it looks: the browser then holds the URL in its own argv and history,
    # so anyone who can read your process list can already read your history.
    # On a shared machine, pass -NoBrowser and use the clipboard.
    try { Start-Process $viewUrl | Out-Null } catch { }
}

Write-Host ""
Say "Save it in your password manager. Cloudflare stores secrets write-only --"
Say "there is no reading one back, only replacing it."
Say "It is read-only and can never write to a store, but anyone holding it can"
Say "read every decision summary on this instance. Treat it like a password."
Write-Host ""

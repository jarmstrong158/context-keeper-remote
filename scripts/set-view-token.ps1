<#
.SYNOPSIS
  One shot: generate a VIEW_TOKEN, install it, verify the route, and open the
  phone view -- without the token being printed, logged, or passed as an argument.

.DESCRIPTION
  Run it and you are done. On a fresh setup it asks nothing. The only prompt it
  can show is a confirmation when a VIEW_TOKEN already exists, because replacing
  one breaks every URL already in use -- and -Yes skips even that.

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
  a single machine, none pasted deliberately. So the token is generated
  in-process, written to wrangler's STDIN (never argv, so it never reaches the
  process list), and displayed only as a mask. It lands in exactly two places:
  Cloudflare, and your clipboard.

  TWO ORDERING RULES, both learned the hard way:

  1. The Worker URL is resolved BEFORE the secret is installed. An installed
     token you cannot build a URL for is unrecoverable -- Cloudflare stores
     secrets write-only, so there is no reading it back, and the only fix is to
     overwrite it. Failing before the write costs nothing; failing after costs
     the token.
  2. Every wrangler call goes through Invoke-Wrangler. On PS 5.1, `2>&1` on a
     native command wraps each stderr line in an ErrorRecord, and with
     $ErrorActionPreference = 'Stop' the first one is terminating -- so an
     ordinary wrangler notice would kill the run. See the function comment.

  Targets Windows PowerShell 5.1, which is what the .cmd wrapper launches and
  what ships with Windows. RNGCryptoServiceProvider and the WebException status
  handling are deliberate 5.1 choices: RandomNumberGenerator::Fill and
  -SkipHttpErrorCheck are .NET Core / PowerShell 7 only and throw here.

.PARAMETER WranglerEnv
  Wrangler environment. "production" for this repo's Worker (the default); pass
  "" for a self-hosted deploy that uses the top-level config.

.PARAMETER WorkerUrl
  Override the deploy URL. Normally read from package.json -> contextKeeper.workerUrl.

.PARAMETER Yes
  Skip the replace-confirmation. Rotating invalidates every existing view URL
  immediately. AUTH_TOKEN is never touched, so MCP connectors keep working.

.PARAMETER NoBrowser
  Do not open the view when it comes up.

.PARAMETER DryRun
  Run every step except the two that change or reveal anything -- the secret is
  not installed and the route is not probed. Exists because the install step is
  otherwise untestable: you cannot exercise it without writing a real production
  credential, which means the one path most likely to fail is the one path
  nobody checks until it fails for a user. With this, the whole preamble can be
  run safely and repeatedly, and a failure reports where it happened.

.EXAMPLE
  .\scripts\set-view-token.ps1
.EXAMPLE
  .\scripts\set-view-token.ps1 -DryRun
.EXAMPLE
  .\scripts\set-view-token.ps1 -WranglerEnv "" -WorkerUrl https://my-worker.me.workers.dev
#>
[CmdletBinding()]
param(
    [string]$WranglerEnv = "production",
    [string]$WorkerUrl = "",
    [switch]$Yes,
    [switch]$NoBrowser,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Some 5.1 installs still default to TLS 1.0, which workers.dev refuses. Without
# this the verification step fails with a connection error that looks like the
# secret did not take.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

# --- run log --------------------------------------------------------------
# Every run records itself. A double-clicked console can close on you, scroll
# past the useful part, or show a PowerShell error whose top line is the least
# informative part of it -- so "what did it say?" is a bad question to have to
# ask someone. The log answers it without anyone copying anything.
#
# It is scrubbed before it is left on disk: the token and the full view URL are
# replaced with the mask, so the log is safe to read, paste, and attach even
# though the run that produced it handled a credential.
$script:LogPath   = Join-Path $repo ".view-setup.log"
$script:LogOn     = $false
$script:TokenSeen = $null
$script:MaskSeen  = $null
try { Start-Transcript -Path $script:LogPath -Force | Out-Null; $script:LogOn = $true } catch { }

function Stop-Log {
    if ($script:LogOn) {
        try { Stop-Transcript | Out-Null } catch { }
        $script:LogOn = $false
    }
    if ($script:TokenSeen -and (Test-Path $script:LogPath)) {
        try {
            $raw = Get-Content $script:LogPath -Raw
            $raw = $raw.Replace($script:TokenSeen, $script:MaskSeen)
            Set-Content -Path $script:LogPath -Value $raw -Encoding UTF8
        } catch { }
    }
}

function Fail($msg) {
    Write-Host "`n  ERROR: $msg`n" -ForegroundColor Red
    Stop-Log
    if (Test-Path $script:LogPath) {
        Write-Host "  A full log of this run is at:" -ForegroundColor DarkGray
        Write-Host "    $script:LogPath" -ForegroundColor DarkGray
        Write-Host "  It has the token masked out, so it is safe to share." -ForegroundColor DarkGray
        Write-Host ""
    }
    exit 1
}
function Say($msg)  { Write-Host "  $msg" }

# An unhandled terminating error would otherwise leave the transcript running
# and the token unscrubbed in it. This also turns PowerShell's default error
# dump -- whose "At line:N char:N" header is the least informative part of it --
# into something that names the failing line.
trap {
    Write-Host "`n  UNHANDLED ERROR" -ForegroundColor Red
    Write-Host "    $($_.Exception.GetType().Name): $($_.Exception.Message)" -ForegroundColor Red
    if ($_.InvocationInfo) {
        Write-Host "    at script line $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())" -ForegroundColor Red
    }
    Stop-Log
    if (Test-Path $script:LogPath) {
        Write-Host "`n  Full log (token masked, safe to share):" -ForegroundColor DarkGray
        Write-Host "    $script:LogPath" -ForegroundColor DarkGray
    }
    Write-Host ""
    exit 1
}

function Invoke-Wrangler {
    <#
      Every wrangler call goes through here, for one reason: on Windows
      PowerShell 5.1, `2>&1` on a NATIVE command does not merely merge streams.
      It wraps each stderr line in an ErrorRecord, and with
      $ErrorActionPreference = 'Stop' the first such record is a TERMINATING
      error. wrangler writes routine notices to stderr, so the script would die
      on a warning -- observed here as an npm "the following package will be
      installed" notice killing the run before wrangler even started.

      Dropping to 'Continue' for the duration of the call is what turns stderr
      back into data. The preference is restored in finally, so the rest of the
      script keeps fail-fast behaviour.
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$WranglerArgs,
        [string]$StdIn
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($PSBoundParameters.ContainsKey('StdIn')) {
            $out = $StdIn | & npx wrangler @WranglerArgs 2>&1 | Out-String
        } else {
            $out = & npx wrangler @WranglerArgs 2>&1 | Out-String
        }
        return [pscustomobject]@{ Output = $out; Code = $LASTEXITCODE }
    } finally {
        $ErrorActionPreference = $prev
    }
}

Write-Host ""
Write-Host "  context-keeper-remote : view token setup" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"
# Into the log, so it explains the environment without anyone being asked to
# describe it. DarkGray keeps it out of the way on screen.
Write-Host "  [PS $($PSVersionTable.PSVersion) $($PSVersionTable.PSEdition) | $([Environment]::OSVersion.VersionString) | $repo]" -ForegroundColor DarkGray

$envArgs = @()
if ($WranglerEnv) { $envArgs = @("--env", $WranglerEnv) }

# --- 1. resolve the Worker URL, BEFORE anything is installed --------------
# No wrangler command reports the workers.dev host -- not whoami, deployments
# list, versions list, or deployments status (all checked). So it is recorded in
# package.json, where a self-hoster changes it once.
if (-not $WorkerUrl) {
    $pkgPath = Join-Path $repo "package.json"
    if (Test-Path $pkgPath) {
        try {
            $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
            if ($pkg.contextKeeper -and $pkg.contextKeeper.workerUrl) {
                $WorkerUrl = [string]$pkg.contextKeeper.workerUrl
            }
        } catch { }
    }
}
if (-not $WorkerUrl -or $WorkerUrl -notmatch '^https://') {
    Fail @"
Could not determine the Worker URL, so nothing was installed.

  Set it once in package.json:

      "contextKeeper": { "workerUrl": "https://<worker>.<account>.workers.dev" }

  or pass it directly:

      .\scripts\set-view-token.ps1 -WorkerUrl https://<worker>.<account>.workers.dev

  This is checked first on purpose: a token installed without a URL to put it
  in is unrecoverable, because Cloudflare cannot read a secret back.
"@
}
$WorkerUrl = $WorkerUrl.TrimEnd('/')
Say "worker  : $WorkerUrl"

# --- 2. preflight ---------------------------------------------------------
# Checked separately so an auth problem reports as an auth problem, instead of
# surfacing later as an opaque "secret put failed".
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Fail "npx not found. Install Node 22+ and re-run."
}
Write-Host "  checking wrangler..." -NoNewline
$who = Invoke-Wrangler -WranglerArgs @("whoami")
if ($who.Code -ne 0 -or $who.Output -match "not authenticated|You are not logged in") {
    Write-Host ""
    Fail "wrangler is not authenticated. Run 'npx wrangler login' and re-run."
}
Write-Host " ok" -ForegroundColor Green

# --- 3. create or replace? ------------------------------------------------
# Only a replace is destructive, so only a replace is worth stopping for.
$secrets = Invoke-Wrangler -WranglerArgs (@("secret", "list") + $envArgs)
if ($secrets.Output -match '"name"\s*:\s*"VIEW_TOKEN"' -and -not $Yes) {
    Write-Host ""
    Write-Host "  A VIEW_TOKEN already exists." -ForegroundColor Yellow
    Write-Host "  Replacing it breaks every view URL already in use, immediately."
    Write-Host "  AUTH_TOKEN is untouched, so MCP connectors keep working."
    $go = Read-Host "  Replace it? [y/N]"
    if ($go -notmatch '^[Yy]') { Write-Host "  cancelled.`n"; exit 0 }
}

# --- 4. generate ----------------------------------------------------------
# 32 bytes from the OS CSPRNG. RNGCryptoServiceProvider rather than
# RandomNumberGenerator::Fill, which does not exist on .NET Framework / PS 5.1.
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$rng.Dispose()
# base64url, so the value is safe as a path segment without escaping.
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$mask  = $token.Substring(0, 4) + ("." * 12) + $token.Substring($token.Length - 4)
# Registered with the logger the instant it exists, so that if anything from
# here on dies and dumps state into the transcript, the scrub still catches it.
$script:TokenSeen = $token
$script:MaskSeen  = $mask

# --- 5. install -----------------------------------------------------------
if ($DryRun) {
    Write-Host "  installing VIEW_TOKEN... SKIPPED (-DryRun)" -ForegroundColor Yellow
    Say "would run: npx wrangler secret put VIEW_TOKEN $($envArgs -join ' ')  (token on stdin)"
    Say "would then poll $WorkerUrl/view/$mask until it returns 200"
    Write-Host ""
    Write-Host "  dry run complete -- every step before the install succeeded." -ForegroundColor Green
    Say "Nothing was installed and nothing was probed."
    Stop-Log
    Say "log: $script:LogPath"
    Write-Host ""
    exit 0
}

Write-Host "  installing VIEW_TOKEN..." -NoNewline
$put = Invoke-Wrangler -WranglerArgs (@("secret", "put", "VIEW_TOKEN") + $envArgs) -StdIn $token
if ($put.Code -ne 0) {
    Write-Host ""
    Say "wrangler reported:"
    ($put.Output -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 6) |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Fail "wrangler secret put failed (exit $($put.Code)). Nothing was changed."
}
Write-Host " ok" -ForegroundColor Green

$viewUrl = "$WorkerUrl/view/$token"

# --- 6. verify ------------------------------------------------------------
# Proves the secret took effect without ever rendering it. Cloudflare needs a
# moment to propagate, so this retries rather than judging on one attempt.
# No -SkipHttpErrorCheck: that is PowerShell 7 only, and on 5.1 a 4xx arrives as
# a terminating WebException carrying the response.
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

# --- 7. hand it over ------------------------------------------------------
$copied = $false
try { Set-Clipboard -Value $viewUrl; $copied = $true } catch { }

Write-Host ""
Write-Host "  done." -ForegroundColor Green
Say "token : $mask   (32 bytes; never printed in full)"
Say "url   : $WorkerUrl/view/$mask"
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
Stop-Log
Write-Host ""

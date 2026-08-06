<#
.SYNOPSIS
  Wire the Knowledge tab to cambium-remote, verifying the URL works BEFORE
  installing it -- and without the value being echoed, logged, or passed as an
  argument.

.DESCRIPTION
  The Knowledge tab needs CAMBIUM_STATUS_URL: cambium-remote's full
  /mcp/<token> connector URL. That is a different Worker with its own
  credential, so unlike VIEW_TOKEN this one cannot be generated here -- it
  already exists, and you have it in your claude.ai connector settings (or your
  password manager).

  Which makes this the paste case rather than the generate case, and the risks
  are different:

  - It is read with Read-Host -AsSecureString, so it never appears on screen and
    never enters console history.
  - It is CHECKED before it is installed. A typo'd or expired connector URL
    installs perfectly happily and then shows up as a Knowledge panel that just
    says "unreachable" -- a failure you would discover on your phone, days
    later, with no idea whether cambium or the wiring was at fault. One status
    call up front turns that into an error here, now, where you can fix it.
  - It goes to wrangler over STDIN, never argv (con-001).

  cambium-remote's `status` is read-only in the strongest sense: it performs no
  writes and deliberately does not increment recall counters, so verifying from
  here cannot perturb the promotion signals the desktop side reasons about.

.PARAMETER WranglerEnv
  Wrangler environment. "production" for this repo's Worker (the default).

.PARAMETER Remove
  Delete the secret instead, turning the Knowledge tab back to its
  "not connected" state.
#>
[CmdletBinding()]
param(
    [string]$WranglerEnv = "production",
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

function Fail($m) { Write-Host "`n  ERROR: $m`n" -ForegroundColor Red; exit 1 }
function Say($m)  { Write-Host "  $m" }

# Same reason as set-view-token.ps1: on PS 5.1, 2>&1 on a native command wraps
# stderr in ErrorRecords and 'Stop' makes the first one terminating, so an
# ordinary wrangler notice would kill the run (con-002).
function Invoke-Wrangler {
    param([Parameter(Mandatory = $true)][string[]]$WranglerArgs, [string]$StdIn)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($PSBoundParameters.ContainsKey('StdIn')) {
            $out = $StdIn | & npx wrangler @WranglerArgs 2>&1 | Out-String
        } else {
            $out = & npx wrangler @WranglerArgs 2>&1 | Out-String
        }
        return [pscustomobject]@{ Output = $out; Code = $LASTEXITCODE }
    } finally { $ErrorActionPreference = $prev }
}

$envArgs = @()
if ($WranglerEnv) { $envArgs = @("--env", $WranglerEnv) }

Write-Host ""
Write-Host "  context-keeper-remote : connect the Knowledge tab" -ForegroundColor Cyan
Write-Host "  ------------------------------------------------"

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { Fail "npx not found. Install Node 22+." }
Write-Host "  checking wrangler..." -NoNewline
$who = Invoke-Wrangler -WranglerArgs @("whoami")
if ($who.Code -ne 0 -or $who.Output -match "not authenticated|not logged in") {
    Write-Host ""; Fail "wrangler is not authenticated. Run 'npx wrangler login' and re-run."
}
Write-Host " ok" -ForegroundColor Green

if ($Remove) {
    $del = Invoke-Wrangler -WranglerArgs (@("secret", "delete", "CAMBIUM_STATUS_URL") + $envArgs)
    if ($del.Code -ne 0) { Fail "could not delete the secret (exit $($del.Code))." }
    Say "Removed. The Knowledge tab will say it is not connected."
    Write-Host ""
    exit 0
}

Write-Host ""
Say "Paste cambium-remote's connector URL. It looks like:"
Say "  https://cambium-remote.<account>.workers.dev/mcp/<token>"
Say "Find it in claude.ai -> Settings -> Connectors -> cambium-remote."
Say "It will not be shown as you type."
Write-Host ""

# [Console]::IsInputRedirected, NOT [Environment]::UserInteractive.
# UserInteractive reports whether the process has a window station, which is
# True even when stdin is a pipe or /dev/null -- so guarding on it means the
# guard never fires and Read-Host blocks forever instead of failing. A script
# that hangs with no output is worse than one that errors, because there is
# nothing to read and nothing to report.
if ([Console]::IsInputRedirected) {
    # Piped in: read one line. This keeps the script usable from automation and,
    # just as importantly, makes it testable at all -- the interactive path
    # cannot be exercised without a human, which is how it shipped broken.
    Say "(reading the URL from stdin)"
    $url = [Console]::In.ReadLine()
} else {
    # -AsSecureString so it never renders and never reaches console history. The
    # plaintext exists only inside this process and is dropped after use.
    $secure = Read-Host "  URL" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $url = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}
# [string] cast rather than ?? -- null-coalescing is PowerShell 7 only and is a
# parse error on the 5.1 that ships with Windows. Same family as con-004: the
# 7-only convenience that looks fine until it runs on the version people have.
$url = ([string]$url).Trim()

if ($url -notmatch '^https://[a-z0-9.\-]+/mcp/.+') {
    Fail "That does not look like an /mcp/<token> connector URL. Nothing was changed."
}

# --- verify BEFORE installing --------------------------------------------
# The whole point: a wrong URL installs fine and then presents as a permanently
# empty panel. Catching it here costs one request.
Write-Host "  checking that cambium-remote answers..." -NoNewline
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status","arguments":{}}}'
try {
    $resp = Invoke-WebRequest -Uri $url -Method Post -TimeoutSec 20 -UseBasicParsing `
        -ContentType "application/json" -Body $body `
        -Headers @{ accept = "application/json, text/event-stream"; "user-agent" = "context-keeper-view/1.0" }
    $text = $resp.Content
} catch [System.Net.WebException] {
    Write-Host ""
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($code -eq 404) {
        Fail "cambium-remote returned 404 -- that token is wrong or has been rotated. Nothing was changed."
    }
    Fail "Could not reach cambium-remote (HTTP $code). Nothing was changed."
} catch {
    Write-Host ""; Fail "Could not reach cambium-remote: $($_.Exception.Message). Nothing was changed."
}

if ($text -notmatch '"(team_active|org_active|counts)"') {
    Write-Host ""
    Fail "cambium-remote answered, but not with the status counts this expects. Nothing was changed."
}
Write-Host " ok" -ForegroundColor Green

# --- install --------------------------------------------------------------
Write-Host "  installing CAMBIUM_STATUS_URL..." -NoNewline
$put = Invoke-Wrangler -WranglerArgs (@("secret", "put", "CAMBIUM_STATUS_URL") + $envArgs) -StdIn $url
if ($put.Code -ne 0) { Write-Host ""; Fail "wrangler secret put failed (exit $($put.Code))." }
Write-Host " ok" -ForegroundColor Green
$url = $null

Write-Host ""
Write-Host "  done." -ForegroundColor Green
Say "The Knowledge tab will show cambium's team and org counts within a minute."
Say "Local scope stays desktop-only by design and never appears here."
Write-Host ""

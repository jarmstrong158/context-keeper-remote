<#
.SYNOPSIS
  Repair cambium-remote's GitHub Actions deploy, which fails silently on every
  merge because its two Cloudflare secrets are empty.

.DESCRIPTION
  Does everything that can be done without a human, and is explicit about the
  one step that cannot:

    CLOUDFLARE_ACCOUNT_ID   read from `wrangler whoami` and set automatically.
                            It is an identifier, not a credential -- it appears
                            in every dashboard URL -- so nothing is being
                            handled here that is not already on screen.

    CLOUDFLARE_API_TOKEN    you paste it once. This is the irreducible step.

  WHY THE TOKEN CANNOT BE AUTOMATED

  Creating a Cloudflare API token requires an existing token carrying the
  "User API Tokens: Edit" permission. Wrangler's OAuth login does not grant
  that -- it is scoped to Workers operations. So there is no credential on this
  machine capable of minting the credential, and no script can conjure one. The
  chicken-and-egg is real, not a limitation of this script.

  Everything AROUND that step is automated: the browser opens on the right page,
  the token is read without echoing, it is VERIFIED against Cloudflare's API
  before being stored, both secrets are written over stdin rather than argv, and
  the previously failed deploy is re-run so you see it go green rather than
  taking my word for it.

  WHETHER YOU NEED THIS AT ALL

  You probably do not. connect-cambium.ps1 now deploys cambium-remote itself
  when it finds the status route missing, using the wrangler login you already
  have. This script only matters if you want cambium-remote to auto-deploy on
  every push to main, the way context-keeper-remote does.

.PARAMETER Repo
  owner/name of the cambium-remote repository.
#>
[CmdletBinding()]
param(
    [string]$Repo = "jarmstrong158/cambium-remote",
    [string]$CambiumDir = ""
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

# con-002: 2>&1 on a native command under 'Stop' makes the first stderr line
# terminating, so an ordinary notice would kill the run.
function Invoke-Native {
    param([Parameter(Mandatory = $true)][string]$Exe,
          [Parameter(Mandatory = $true)][string[]]$Args,
          [string]$StdIn, [string]$In = "")
    $prev = $ErrorActionPreference; $prevLoc = Get-Location
    $ErrorActionPreference = 'Continue'
    try {
        if ($In) { Set-Location $In }
        if ($PSBoundParameters.ContainsKey('StdIn')) {
            $out = $StdIn | & $Exe @Args 2>&1 | Out-String
        } else {
            $out = & $Exe @Args 2>&1 | Out-String
        }
        return [pscustomobject]@{ Output = $out; Code = $LASTEXITCODE }
    } finally { $ErrorActionPreference = $prev; Set-Location $prevLoc }
}

Write-Host ""
Write-Host "  repair cambium-remote's CI deploy" -ForegroundColor Cyan
Write-Host "  ---------------------------------"

foreach ($exe in @("npx", "gh")) {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        Fail "$exe not found. Need Node 22+ and the GitHub CLI (gh)."
    }
}
if (-not $CambiumDir) { $CambiumDir = Join-Path (Split-Path -Parent $repo) "cambium-remote" }

Write-Host "  checking gh auth..." -NoNewline
$auth = Invoke-Native -Exe "gh" -Args @("auth", "status")
if ($auth.Code -ne 0) { Write-Host ""; Fail "gh is not authenticated. Run: gh auth login" }
Write-Host " ok" -ForegroundColor Green

# --- 1. account id, fully automatic ---------------------------------------
Write-Host "  reading account id from wrangler..." -NoNewline
$who = Invoke-Native -Exe "npx" -Args @("wrangler", "whoami") -In $CambiumDir
if ($who.Code -ne 0) { Write-Host ""; Fail "wrangler is not authenticated. Run: npx wrangler login" }
$acct = ""
if ($who.Output -match '([0-9a-f]{32})') { $acct = $Matches[1] }
if (-not $acct) { Write-Host ""; Fail "Could not find an account id in wrangler whoami output." }
Write-Host " ok" -ForegroundColor Green
Say "account id : $($acct.Substring(0,6))..$($acct.Substring($acct.Length-4))"

Write-Host "  setting CLOUDFLARE_ACCOUNT_ID..." -NoNewline
$s1 = Invoke-Native -Exe "gh" -Args @("secret", "set", "CLOUDFLARE_ACCOUNT_ID", "--repo", $Repo) -StdIn $acct
if ($s1.Code -ne 0) {
    Write-Host ""
    ($s1.Output -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -Last 4) |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Fail "gh secret set failed. Does your gh token have repo admin on $Repo?"
}
Write-Host " ok" -ForegroundColor Green

# --- 2. the api token, the one manual step --------------------------------
Write-Host ""
Say "Now the API token. This is the only part a script cannot do: creating a"
Say "Cloudflare API token requires an existing token with 'User API Tokens:"
Say "Edit', and wrangler's OAuth login is not one. Nothing on this machine can"
Say "mint it."
Write-Host ""
Say "Opening the Cloudflare token page. Use the 'Edit Cloudflare Workers'"
Say "template, click through, and copy the token it shows you ONCE."
Write-Host ""
try { Start-Process "https://dash.cloudflare.com/profile/api-tokens" | Out-Null } catch {
    Say "(could not open a browser -- go to https://dash.cloudflare.com/profile/api-tokens)"
}

if ([Console]::IsInputRedirected) {
    Fail "Nothing is attached to answer the prompt, so the token cannot be read without echoing it. Run this from a terminal."
}

# -AsSecureString: never rendered, never in console history.
$secure = Read-Host "  Paste the token" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$token = ([string]$token).Trim()

if ($token.Length -lt 20) { Fail "That does not look like a Cloudflare API token. Nothing was changed." }

# --- 3. verify BEFORE storing ---------------------------------------------
# A wrong token stores perfectly happily and then fails on the NEXT merge,
# whenever that is -- which is exactly the silent-failure mode being repaired.
Write-Host "  verifying the token with Cloudflare..." -NoNewline
try {
    $resp = Invoke-WebRequest -Uri "https://api.cloudflare.com/client/v4/user/tokens/verify" `
        -Method Get -TimeoutSec 25 -UseBasicParsing `
        -Headers @{ Authorization = "Bearer $token" }
    $okToken = ($resp.Content -match '"success"\s*:\s*true')
} catch {
    Write-Host ""
    Fail "Cloudflare rejected that token. Nothing was changed. (Check you copied all of it.)"
}
if (-not $okToken) { Write-Host ""; Fail "Cloudflare did not report the token as active. Nothing was changed." }
Write-Host " ok" -ForegroundColor Green

Write-Host "  setting CLOUDFLARE_API_TOKEN..." -NoNewline
$s2 = Invoke-Native -Exe "gh" -Args @("secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", $Repo) -StdIn $token
$token = $null
if ($s2.Code -ne 0) { Write-Host ""; Fail "gh secret set failed for the token." }
Write-Host " ok" -ForegroundColor Green

# --- 4. prove it, do not assert it ----------------------------------------
Write-Host ""
Say "Re-running the last failed deploy so you can see it go green."
$runs = Invoke-Native -Exe "gh" -Args @("run", "list", "--repo", $Repo, "--workflow", "deploy.yml",
                                        "--limit", "1", "--json", "databaseId,conclusion")
if ($runs.Output -match '"databaseId"\s*:\s*(\d+)') {
    $id = $Matches[1]
    $rr = Invoke-Native -Exe "gh" -Args @("run", "rerun", $id, "--repo", $Repo)
    if ($rr.Code -eq 0) {
        Say "Started. Watch it with:"
        Say "    gh run watch $id --repo $Repo"
    } else {
        Say "Could not re-run automatically. Push any commit, or re-run it from the Actions tab."
    }
} else {
    Say "No previous deploy run found. The next push to main will use the new secrets."
}

Write-Host ""
Write-Host "  done." -ForegroundColor Green
Say "Both secrets are set and the token was verified live before being stored."
Say "You never needed this for the phone view -- connect-cambium.ps1 deploys"
Say "cambium-remote itself when it has to. This is only for auto-deploy on push."
Write-Host ""

<#
.SYNOPSIS
  Make `git push` deploy the Worker. No API token, no GitHub secret, no
  dashboard, nothing to paste -- and nothing left for a human to remember.

.DESCRIPTION
  Installs a git pre-push hook that runs `wrangler deploy` before the push
  completes, using the wrangler login already on this machine.

  WHY THIS RATHER THAN FIXING CI

  cambium-remote's GitHub Actions deploy needs CLOUDFLARE_API_TOKEN. That token
  can only be minted by Cloudflare, and minting one through the API requires an
  existing token carrying "User API Tokens: Edit". Wrangler's OAuth session does
  not have it -- its 29 scopes are workers/d1/pages/queues operations and
  account:read, with nothing token-management related. So there is no credential
  on this machine capable of creating that credential, and no script can close
  that loop. The manual paste is not a gap in the tooling; it is the shape of
  Cloudflare's permission model.

  Deploying locally sidesteps the whole question. The credential needed is one
  you already have and already use.

  WHY pre-push AND NOT post-something

  git has no post-push hook, and that turns out to be the better ordering
  anyway: this deploys FIRST and aborts the push if the deploy fails. So origin
  never receives a commit that could not be deployed, which is the opposite of
  the failure being fixed here -- cambium-remote's CI was accepting every merge
  and deploying none of them, and main drifted ahead of the running Worker with
  nothing to show it.

  It fires only for pushes to main, skips branch deletes, and is skippable with
  `git push --no-verify` when you genuinely want to push without deploying.

.PARAMETER RepoDir
  The repository to install into. Defaults to the cambium-remote checkout beside
  this one.

.PARAMETER Remove
  Uninstall the hook.
#>
[CmdletBinding()]
param(
    [string]$RepoDir = "",
    # The wrangler environment the hook should deploy. Left empty it emits a
    # bare `wrangler deploy`, which is correct ONLY for a repo with no named
    # environments. See the guard below -- getting this wrong is the most
    # damaging thing this script could do.
    [string]$Env = "",
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSScriptRoot
Set-Location $here

function Fail($m) { Write-Host "`n  ERROR: $m`n" -ForegroundColor Red; exit 1 }
function Say($m)  { Write-Host "  $m" }

Write-Host ""
Write-Host "  install the deploy-on-push hook" -ForegroundColor Cyan
Write-Host "  -------------------------------"

if (-not $RepoDir) { $RepoDir = Join-Path (Split-Path -Parent $here) "cambium-remote" }
$gitDir = Join-Path $RepoDir ".git"
if (-not (Test-Path $gitDir)) { Fail "$RepoDir is not a git repository. Pass -RepoDir <path>." }
Say "repo : $RepoDir"

# .git/hooks is the default, but a repo can point elsewhere via core.hooksPath.
# Writing to the wrong directory installs a hook that never runs -- silently,
# which is the same class of failure as the CI this replaces.
$hooksPath = ""
try {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $hooksPath = (& git -C $RepoDir config --get core.hooksPath 2>&1 | Out-String).Trim()
    $ErrorActionPreference = $prev
} catch { }
if ($hooksPath -and $hooksPath -notmatch '^fatal|error') {
    $hookDir = if ([IO.Path]::IsPathRooted($hooksPath)) { $hooksPath } else { Join-Path $RepoDir $hooksPath }
    Say "hooks: $hookDir  (core.hooksPath is set)"
} else {
    $hookDir = Join-Path $gitDir "hooks"
    Say "hooks: $hookDir"
}
if (-not (Test-Path $hookDir)) { New-Item -ItemType Directory -Path $hookDir -Force | Out-Null }
$hookFile = Join-Path $hookDir "pre-push"

# --- refuse to emit a deploy that would target the wrong profile ----------
# A bare `wrangler deploy` uses the TOP-LEVEL config. In a repo that keeps its
# real deployment under a named environment, the top level is usually the
# self-host profile -- and in context-keeper-remote's case that profile declares
# a D1 binding with NO database_id, so Cloudflare AUTO-PROVISIONS a fresh empty
# database and binds the live Worker to it. A hook installed without -Env there
# would silently replace a populated production database with an empty one on
# the next push.
#
# That is not hypothetical: this script was pointed at context-keeper-remote
# during development and would have done exactly that. So the check is not a
# warning, it is a refusal.
$envNames = @()
$wrangler = Join-Path $RepoDir "wrangler.toml"
if (Test-Path $wrangler) {
    $envNames = @(Select-String -Path $wrangler -Pattern '^\s*\[env\.([A-Za-z0-9_-]+)' |
                  ForEach-Object { $_.Matches.Groups[1].Value } | Sort-Object -Unique)
}
if ($envNames.Count -gt 0 -and -not $Env) {
    Write-Host ""
    Say "$RepoDir defines named wrangler environments: $($envNames -join ', ')"
    Say "A bare 'wrangler deploy' would deploy the TOP-LEVEL profile instead,"
    Say "which in these repos is the self-host profile -- and that one leaves"
    Say "database_id unset so Cloudflare provisions a NEW EMPTY database and"
    Say "binds the live Worker to it."
    Write-Host ""
    Fail "Refusing to install a hook that would deploy the wrong profile. Re-run with -Env <name>, e.g. -Env $($envNames[0])."
}
if ($Env -and $envNames -notcontains $Env) {
    Fail "$RepoDir has no [env.$Env] section. Found: $(if($envNames){$envNames -join ', '}else{'none'})."
}
$deployCmd = if ($Env) { "npx wrangler deploy --env $Env" } else { "npx wrangler deploy" }
Say "deploy : $deployCmd"

if ($Remove) {
    if (Test-Path $hookFile) {
        Remove-Item $hookFile -Force
        Say "Removed. `git push` no longer deploys."
    } else { Say "No hook installed; nothing to remove." }
    Write-Host ""
    exit 0
}

if ((Test-Path $hookFile) -and -not ((Get-Content $hookFile -Raw) -match "context-keeper deploy-on-push")) {
    Fail "A pre-push hook already exists at $hookFile and was not written by this script. Not overwriting it. Merge them by hand, or pass -Remove first."
}

# LF endings and no BOM: git runs hooks through sh, and a CRLF shebang line
# fails as "bad interpreter" while naming a file that plainly exists.
$hookTemplate = @'
#!/bin/sh
# context-keeper deploy-on-push
#
# Deploys this Worker before the push completes, so origin never receives a
# commit that could not be deployed. Installed by
# context-keeper-remote/scripts/install-deploy-hook.ps1
#
# Exists because the GitHub Actions deploy needs a Cloudflare API token that
# only a human can create -- Cloudflare will not mint one without an existing
# token that has "User API Tokens: Edit", which wrangler's OAuth login lacks.
# Deploying from here uses the login you already have.
#
# Skip once with: git push --no-verify

while read -r local_ref local_sha remote_ref remote_sha; do
  # main only.
  case "$remote_ref" in
    refs/heads/main|refs/heads/master) ;;
    *) continue ;;
  esac
  # A branch delete pushes the all-zero sha; there is nothing to deploy.
  case "$local_sha" in
    *[!0]*) ;;
    *) continue ;;
  esac

  echo ""
  echo "  deploying before push (pre-push hook)..."
  if ! __DEPLOY_CMD__; then
    echo ""
    echo "  DEPLOY FAILED -- push aborted." >&2
    echo "  origin has not been updated, so main will not drift ahead of the" >&2
    echo "  running Worker. Fix the deploy, or push with --no-verify to skip." >&2
    exit 1
  fi
  echo "  deployed. continuing with the push."
  echo ""
done

exit 0
'@ -replace "`r`n", "`n"
$hook = $hookTemplate.Replace('__DEPLOY_CMD__', $deployCmd)

[IO.File]::WriteAllText($hookFile, $hook, (New-Object System.Text.UTF8Encoding $false))

# Windows git honours the file's exec bit through the index, not the filesystem,
# but chmod is harmless here and required anywhere else.
try {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & git -C $RepoDir update-index --add --chmod=+x (Join-Path ".git/hooks" "pre-push") 2>&1 | Out-Null
    $ErrorActionPreference = $prev
} catch { }

Write-Host ""
Write-Host "  done." -ForegroundColor Green
Say "`git push` from $RepoDir now deploys first and aborts if the deploy fails."
Say "Nothing to paste, no API token, no GitHub secret."
Say ""
Say "Skip once with: git push --no-verify"
Say "Uninstall with: -Remove"
Write-Host ""

#!/usr/bin/env bash
# One shot: generate a VIEW_TOKEN, install it, verify the route, and open the
# phone view -- without the token being printed, logged, or passed as an argument.
#
# Run it and you are done. On a fresh setup it asks nothing. The only prompt it
# will ever show is a confirmation when a VIEW_TOKEN already exists, because
# replacing one breaks every URL already in use; CK_YES=1 skips even that.
#
# The view URL is a credential, and every ordinary way of setting one leaks it:
# an argv value goes to shell history AND the process list (readable by any
# other user for the duration of the call), an echoed value goes to shell
# history, and a printed value goes to scrollback, screen-shares, screenshots,
# and the transcript of any coding agent that ran it. That last one is measured,
# not theoretical: this repo's README documents connector URLs found in ~54
# occurrences across 13 local session transcripts on one machine. So the token
# is generated here, written to wrangler's STDIN, and shown only as a mask.
#
# Usage:
#   scripts/set-view-token.sh                          # this repo's Worker
#   CK_ENV= scripts/set-view-token.sh                  # self-hosted, top-level config
#   CK_WORKER_URL=https://x.workers.dev scripts/set-view-token.sh
#   CK_YES=1 scripts/set-view-token.sh                 # no prompt on replace
#   CK_NO_BROWSER=1 scripts/set-view-token.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_NAME="${CK_ENV-production}"
ENV_ARGS=()
[ -n "$ENV_NAME" ] && ENV_ARGS=(--env "$ENV_NAME")

say() { printf '  %s\n' "$1"; }

printf '\n  context-keeper-remote : view token setup\n'
printf '  ----------------------------------------\n'

command -v npx >/dev/null 2>&1 || { echo "  ERROR: npx not found (need Node 22+)."; exit 1; }

# Resolve the Worker URL FIRST, before anything is installed. An installed token
# you cannot build a URL for is unrecoverable: Cloudflare stores secrets
# write-only, so there is no reading it back, and the only fix is to overwrite
# it. Failing before the write costs nothing; failing after costs the token.
#
# No wrangler command reports the workers.dev host -- not whoami, deployments
# list, versions list, or deployments status (all checked) -- so it lives in
# package.json, where a self-hoster changes it once.
WORKER_URL="${CK_WORKER_URL-}"
if [ -z "$WORKER_URL" ]; then
  WORKER_URL="$(node -e "try{var p=require('./package.json');process.stdout.write((p.contextKeeper&&p.contextKeeper.workerUrl)||'')}catch(e){}" 2>/dev/null || true)"
fi
case "$WORKER_URL" in
  https://*) ;;
  *)
    printf '\n  ERROR: Could not determine the Worker URL, so nothing was installed.\n\n'
    printf '  Set it once in package.json:\n\n'
    printf '      "contextKeeper": { "workerUrl": "https://<worker>.<account>.workers.dev" }\n\n'
    printf '  or pass it directly:\n\n'
    printf '      CK_WORKER_URL=https://<worker>.<account>.workers.dev scripts/set-view-token.sh\n\n'
    printf '  This is checked first on purpose: a token installed without a URL to\n'
    printf '  put it in is unrecoverable, because Cloudflare cannot read a secret back.\n\n'
    exit 1;;
esac
WORKER_URL="${WORKER_URL%/}"
say "worker  : $WORKER_URL"

# Checked separately so an auth problem reports as an auth problem, rather than
# surfacing later as an opaque "secret put failed".
printf '  checking wrangler...'
if ! npx wrangler whoami >/dev/null 2>&1; then
  printf '\n  ERROR: wrangler is not authenticated. Run: npx wrangler login\n\n'; exit 1
fi
printf ' ok\n'

# Only a replace is destructive, so only a replace is worth stopping for.
if [ -z "${CK_YES-}" ] \
   && npx wrangler secret list "${ENV_ARGS[@]}" 2>/dev/null | grep -q '"VIEW_TOKEN"'; then
  printf '\n  A VIEW_TOKEN already exists.\n'
  printf '  Replacing it breaks every view URL already in use, immediately.\n'
  printf '  AUTH_TOKEN is untouched, so MCP connectors keep working.\n'
  read -r -p "  Replace it? [y/N] " go
  case "$go" in [Yy]*) ;; *) printf '  cancelled.\n\n'; exit 0;; esac
fi

# 32 bytes from the OS CSPRNG; base64url so it is safe as a path segment.
TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
MASK="${TOKEN:0:4}............${TOKEN: -4}"

# CK_DRY_RUN runs every step except the two that change or reveal anything.
# The install step is otherwise untestable -- exercising it means writing a real
# production credential, so the path most likely to fail is the one nobody
# checks until it fails for a user.
if [ -n "${CK_DRY_RUN-}" ]; then
  printf '  installing VIEW_TOKEN... SKIPPED (CK_DRY_RUN)\n'
  say "would run: npx wrangler secret put VIEW_TOKEN ${ENV_ARGS[*]-}  (token on stdin)"
  say "would then poll $WORKER_URL/view/$MASK until it returns 200"
  printf '\n  dry run complete -- every step before the install succeeded.\n'
  say "Nothing was installed and nothing was probed."
  printf '\n'
  exit 0
fi

printf '  installing VIEW_TOKEN...'
# STDIN, never argv: an argument is visible in the process list to other users.
if ! printf '%s' "$TOKEN" | npx wrangler secret put VIEW_TOKEN "${ENV_ARGS[@]}" >/dev/null 2>&1; then
  printf '\n  ERROR: wrangler secret put failed. Run it by hand to see why:\n'
  printf '         npx wrangler secret put VIEW_TOKEN %s\n\n' "${ENV_ARGS[*]-}"
  exit 1
fi
printf ' ok\n'

VIEW_URL="$WORKER_URL/view/$TOKEN"

# Proves the secret took effect without ever rendering it. Cloudflare needs a
# moment to propagate, so this retries rather than judging on one attempt.
# 60 seconds, not 24. `wrangler secret put` does not merely store a value: it
# creates a NEW Worker version and rolls it out. Until that reaches an edge,
# requests there are served by the PREVIOUS version holding the PREVIOUS token,
# so a correct token legitimately 404s for a while (con-006). A short window
# reports a credential failure for a credential that is fine, and the natural
# next move -- regenerating, redeploying -- chases nothing.
printf '  waiting for the new version to roll out (up to 60s)'
CODE=0
for _ in $(seq 1 20); do
  sleep 3
  printf '.'
  CODE="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -I "$VIEW_URL" || echo 0)"
  [ "$CODE" = "200" ] && break
done
if [ "$CODE" = "200" ]; then
  printf ' live (HTTP 200)\n'
elif [ "$CODE" = "404" ]; then
  printf ' still 404\n'
  say "The secret is set, but the route did not answer within 60s. Two causes,"
  say "in likelihood order:"
  say "  1. the Worker has not been deployed since /view was added -- check that"
  say "     its Deploy workflow SUCCEEDED, filtering by workflow name, since"
  say "     gh run list alone returns CI rather than Deploy;"
  say "  2. an unusually slow rollout. Re-running is safe and cheap."
else
  printf ' no answer (HTTP %s)\n' "$CODE"
  say "The secret is set, but the route did not answer within 60s. Two causes:"
  say "  1. the Worker has not been deployed since /view was added; or"
  say "  2. an unusually slow rollout -- re-running is safe and cheap."
fi

COPIED=""
for c in pbcopy "xclip -selection clipboard" "xsel --clipboard --input" wl-copy clip.exe; do
  if command -v "${c%% *}" >/dev/null 2>&1; then
    printf '%s' "$VIEW_URL" | $c >/dev/null 2>&1 && COPIED=1 && break
  fi
done

# Saved to disk so nobody has to remember it, and so `npm run view` can reopen
# it. Cloudflare stores secrets write-only, so if the clipboard were the only
# copy, one stray Ctrl-C would mean re-running setup and dropping every enrolled
# device. Every CLI keeps its own token on disk -- npm, gh, aws, wrangler --
# and it is strictly better than asking a person to hold 43 characters.
#
# umask sets the mode at creation so there is no window where the file is
# world-readable; the explicit chmod is the belt to those suspenders, since
# umask is inherited and a caller can have loosened it.
OUT="$(dirname "${BASH_SOURCE[0]}")/../.view-url"
( umask 077; printf '%s' "$VIEW_URL" > "$OUT" )
chmod 600 "$OUT" 2>/dev/null || true

printf '\n  done.\n'
say "token : $MASK   (32 bytes; never printed in full)"
say "url   : ${WORKER_URL%/}/view/$MASK"
say "Saved (mode 600). Reopen it any time with: npm run view"
if [ -n "$COPIED" ]; then
  printf '  The full URL is on your clipboard.\n'
else
  # No clipboard on this box. Printing it would put the credential in
  # scrollback -- the worst of the three leak channels this script exists to
  # avoid, since scrollback is what gets screen-shared, screenshotted, and
  # captured by agent transcripts. The saved file is access-controlled and
  # deliberate instead, and you decide when to read it.
  printf '  No clipboard tool found; read it from the saved file when you need it.\n'
fi

# The QR is what makes this install-once on a phone: the alternative is
# transferring 43 characters by hand, which is friction AND a new place the
# credential lives. Piped over stdin, never argv (the process list is readable
# by other users), matching the rest of this script.
if [ "$CODE" = "200" ] && command -v node >/dev/null 2>&1; then
  printf '\n  Scan this with your phone camera, then Add to Home Screen:\n\n'
  printf '%s' "$VIEW_URL" | node "$(dirname "${BASH_SOURCE[0]}")/show-qr.mjs" 2>/dev/null \
    || printf '  (QR unavailable -- run npm install, or use the clipboard URL)\n'
fi

# Once it is in browser history you can bookmark it or push it to your phone
# through browser sync, so losing the clipboard is not losing the URL.
#
# This is the one place the URL is passed as an argument, which the rest of the
# script goes out of its way to avoid. It is unavoidable -- there is no way to
# hand a URL to a browser over stdin -- and it is a smaller exposure than it
# looks: the browser itself then holds the URL in argv and in history, so anyone
# who can read your process list can already read your history. On a shared
# machine, set CK_NO_BROWSER=1 and use the clipboard.
if [ -z "${CK_NO_BROWSER-}" ] && [ "$CODE" = "200" ]; then
  for o in open xdg-open; do
    command -v "$o" >/dev/null 2>&1 && { say "Opening it in your browser..."; "$o" "$VIEW_URL" >/dev/null 2>&1 || true; break; }
  done
fi

printf '\n'
say "Save it in your password manager. Cloudflare stores secrets write-only --"
say "there is no reading one back, only replacing it."
say "It is read-only and can never write to a store, but anyone holding it can"
say "read every decision summary on this instance. Treat it like a password."
printf '\n'

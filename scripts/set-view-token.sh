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
printf '  verifying...'
CODE=0
for _ in 1 2 3 4 5 6 7 8; do
  sleep 3
  CODE="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -I "$VIEW_URL" || echo 0)"
  [ "$CODE" = "200" ] && break
done
if [ "$CODE" = "200" ]; then
  printf ' live (HTTP 200)\n'
elif [ "$CODE" = "404" ]; then
  printf ' still 404\n'
  say "The secret is set, but the route is not answering. The likeliest cause is"
  say "a Worker deployed before the /view route existed -- redeploy, then open"
  say "the URL below. Re-running this script is not needed."
else
  printf ' no answer (HTTP %s)\n' "$CODE"
  say "The secret is set. Propagation can take a minute; try the URL shortly."
fi

COPIED=""
for c in pbcopy "xclip -selection clipboard" "xsel --clipboard --input" wl-copy clip.exe; do
  if command -v "${c%% *}" >/dev/null 2>&1; then
    printf '%s' "$VIEW_URL" | $c >/dev/null 2>&1 && COPIED=1 && break
  fi
done

printf '\n  done.\n'
say "token : $MASK   (32 bytes; never printed in full)"
say "url   : ${WORKER_URL%/}/view/$MASK"
if [ -n "$COPIED" ]; then
  printf '  The full URL is on your clipboard.\n'
else
  # Headless box, no clipboard. Printing it would put the credential in
  # scrollback -- which is one of the three leak channels this whole script
  # exists to avoid, and the worst of them, since scrollback is what gets
  # screen-shared, screenshotted, and captured by agent transcripts. A
  # mode-600 file is access-controlled and deliberate instead, and the user
  # decides when to read it and when it stops existing.
  OUT=".view-url"
  # umask sets the mode at creation so there is no window where the file is
  # world-readable; the explicit chmod is the belt to that suspenders, because
  # umask is inherited and a caller can have loosened it.
  ( umask 077; printf '%s\n' "$VIEW_URL" > "$OUT" )
  chmod 600 "$OUT" 2>/dev/null || true
  printf '  No clipboard tool found, so the URL was written to %s (mode 600)\n' "$OUT"
  printf '  rather than printed -- terminal scrollback is exactly the leak this\n'
  printf '  script avoids. Read it, save it, then delete it:\n\n'
  printf '      cat %s && rm %s\n' "$OUT" "$OUT"
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

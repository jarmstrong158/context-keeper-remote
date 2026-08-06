#!/usr/bin/env bash
# Generate a VIEW_TOKEN, set it on the Worker, and print the view URL -- without
# the value reaching shell history, the process list, or any log.
#
# Same reasoning as the PowerShell version: the view URL is a credential, and
# the usual ways of setting one (an argv value, an echo, a "here is your token"
# line) are exactly how credentials end up in scrollback, screenshots and agent
# transcripts. This project's README documents that happening ~54 times across
# 13 transcripts on one machine.
#
# Usage:
#   scripts/set-view-token.sh                  # this repo's Worker (--env production)
#   CK_ENV= scripts/set-view-token.sh          # self-hosted, top-level config
#   CK_WORKER_URL=https://x.workers.dev scripts/set-view-token.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_NAME="${CK_ENV-production}"
ENV_ARGS=()
[ -n "$ENV_NAME" ] && ENV_ARGS=(--env "$ENV_NAME")

printf '\n  context-keeper-remote : view token setup\n'
printf '  ----------------------------------------\n'

command -v npx >/dev/null 2>&1 || { echo "  ERROR: npx not found (need Node 22+)."; exit 1; }

printf '  checking wrangler auth...'
if ! npx wrangler whoami >/dev/null 2>&1; then
  printf '\n  ERROR: wrangler is not authenticated. Run: npx wrangler login\n\n'; exit 1
fi
printf ' ok\n'

printf '\n  This sets VIEW_TOKEN. Any existing one is REPLACED and every existing\n'
printf '  view URL stops working. AUTH_TOKEN is untouched, so MCP connectors\n  keep working.\n'
read -r -p "  Continue? [y/N] " go
case "$go" in [Yy]*) ;; *) printf '  cancelled.\n\n'; exit 0;; esac

# 32 bytes from the OS CSPRNG, base64url so it is path-safe.
TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"

printf '  setting VIEW_TOKEN...'
# STDIN, never argv: an argument is visible in the process list to other users.
if ! printf '%s' "$TOKEN" | npx wrangler secret put VIEW_TOKEN "${ENV_ARGS[@]}" >/dev/null 2>&1; then
  printf '\n  ERROR: wrangler secret put failed. Run it manually to see why:\n'
  printf '         npx wrangler secret put VIEW_TOKEN %s\n\n' "${ENV_ARGS[*]-}"
  exit 1
fi
printf ' ok\n'

WORKER_URL="${CK_WORKER_URL-}"
if [ -z "$WORKER_URL" ]; then
  WORKER_URL="$(npx wrangler deployments list "${ENV_ARGS[@]}" 2>/dev/null \
    | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 || true)"
fi
[ -z "$WORKER_URL" ] && WORKER_URL="https://<your-worker>.workers.dev"

VIEW_URL="${WORKER_URL%/}/view/$TOKEN"
MASK="${TOKEN:0:4}............${TOKEN: -4}"

# Clipboard if one exists; otherwise the URL is printed once, which on a
# developer's own terminal is the least-bad remaining option.
COPIED=""
for c in pbcopy "xclip -selection clipboard" xsel wl-copy clip.exe; do
  if command -v "${c%% *}" >/dev/null 2>&1; then
    printf '%s' "$VIEW_URL" | $c >/dev/null 2>&1 && COPIED=1 && break
  fi
done

printf '\n  done.\n'
printf '  token   : %s   (32 bytes, never printed in full)\n' "$MASK"
if [ -n "$COPIED" ]; then
  printf '  url     : %s/view/%s\n' "${WORKER_URL%/}" "$MASK"
  printf '  clipboard: the FULL url is on your clipboard right now\n'
else
  printf '  url     : %s\n' "$VIEW_URL"
  printf '  (no clipboard tool found, so it is shown once -- save it now)\n'
fi
printf '\n  NEXT:\n'
printf '    1. Paste it into your password manager NOW. Cloudflare stores secrets\n'
printf '       write-only -- you cannot read it back, only replace it.\n'
printf '    2. Open it on your phone and Add to Home Screen.\n\n'
printf '  Treat that URL like a password. It is read-only (it can never write to a\n'
printf '  store) but anyone holding it can read every decision summary.\n\n'

printf '  verifying...'
for _ in 1 2 3 4 5 6; do
  sleep 3
  code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -I "$VIEW_URL" || true)"
  if [ "$code" = "200" ]; then printf ' live (HTTP 200)\n\n'; exit 0; fi
done
printf ' not answering yet\n'
printf '  The secret is set; propagation can take a minute. If it still 404s after\n'
printf '  that, confirm the Worker was deployed with the /view route.\n\n'

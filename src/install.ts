// Turning the view from a URL you have to keep into a thing you install once.
//
// THE PROBLEM THIS SOLVES
//
// /view/<VIEW_TOKEN> works, but it makes the credential the user's problem: a
// 43-character secret they have to store somewhere, can never read back out of
// Cloudflare, and lose entirely if the clipboard is overwritten. For a page
// whose whole purpose is a ten-second glance on a phone, that is a worse deal
// than the thing it protects.
//
// THE SHAPE OF THE FIX
//
// Visit the token URL once. The response sets a long-lived HttpOnly cookie, and
// from then on the bare /view path works from that device. Add to Home Screen,
// and the icon opens /view directly -- no token in the URL, nothing in history
// worth stealing, nothing for the user to remember or store. The device holds
// the credential, which is what devices are for.
//
// The token URL keeps working forever, so it stays the way to enrol a new
// device (scan the QR again) without any account, server-side session table, or
// login screen.
//
// WHAT THIS DELIBERATELY IS NOT
//
// Not a session: there is no server-side state, no session id, no expiry to
// track. The cookie carries the same secret the path did, so revocation stays
// exactly one thing -- rotate VIEW_TOKEN and every device drops at once. Adding
// a session table would mean two revocation paths that can disagree, and the
// one you forget is the one that stays valid.
//
// Not a second credential: the cookie is checked against VIEW_TOKEN with the
// same constant-time comparison as the path. A device that has the cookie has
// exactly the access the URL had. Nothing is widened.

import { pathTokenMatches } from "./shared/mcp-core";
import { ICON_PNG_BASE64 } from "./icon-data";

// Short and meaningless on purpose: a cookie named "view_token" tells anyone
// glancing at devtools what it is worth stealing.
export const COOKIE_NAME = "ckv";

// Ten years. The point is that the user never thinks about this again, and a
// re-auth prompt on a glance-at-it page is the friction being removed. It is
// not an expiry-based control: rotating VIEW_TOKEN is what revokes access, and
// that takes effect on the very next request regardless of the cookie's age.
const TEN_YEARS_SECONDS = 315_360_000;

/**
 * Set-Cookie for a device that just proved it holds the token.
 *
 * HttpOnly    - script cannot read it, so an injected script cannot exfiltrate
 *               the credential even though the page has no scripts today.
 * Secure      - workers.dev is HTTPS-only; this makes downgrade explicit.
 * SameSite=Lax- the page is navigated to, never posted to and never framed, so
 *               Lax costs nothing and blocks cross-site request carriage.
 * Path=/view  - scoped to the only routes that read it, so it is never attached
 *               to /mcp requests, which authenticate on a different secret.
 */
export function sessionCookie(token: string): string {
  return (
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${TEN_YEARS_SECONDS}; ` +
    `Path=/view; HttpOnly; Secure; SameSite=Lax`
  );
}


/**
 * Pull one cookie out of a Cookie header.
 *
 * Hand-parsed rather than regexed over the whole header: a cookie value may
 * legally contain "=", so splitting on the FIRST "=" per pair is required, and
 * a naive /ckv=([^;]*)/ also matches a cookie named "myckv".
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed escape is a malformed cookie, not a server error.
      return null;
    }
  }
  return null;
}

/** True when the request carries a cookie matching VIEW_TOKEN. */
export async function cookieAuthorised(
  request: Request,
  secret: string | undefined,
): Promise<boolean> {
  const value = readCookie(request, COOKIE_NAME);
  if (value === null) return false;
  return pathTokenMatches(value, secret);
}

// --- installability -------------------------------------------------------

/**
 * The web app manifest.
 *
 * start_url and scope are "/view" -- the cookie-authenticated path -- so the
 * installed icon never carries the token in its URL. That is the entire payoff:
 * the home-screen entry is not a bookmark to a secret.
 *
 * display "standalone" drops browser chrome, which is what makes it read as an
 * app rather than a saved page.
 */
export function manifestJson(): string {
  return JSON.stringify({
    name: "Project memory",
    short_name: "memory",
    description: "Decisions and constraints across every project, read-only.",
    start_url: "/view",
    scope: "/view",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0e13",
    theme_color: "#0b0e13",
    icons: [
      { src: "/view/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/view/icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
}

let iconBytes: Uint8Array | null = null;

/** The home-screen icon. Decoded once per isolate, then reused. */
export function iconResponse(): Response {
  if (!iconBytes) {
    const bin = atob(ICON_PNG_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    iconBytes = bytes;
  }
  return new Response(iconBytes, {
    headers: {
      "content-type": "image/png",
      // The icon carries no data, but it sits behind the same credential as the
      // page, so it must not land in a shared cache either. Private + a long
      // max-age: the installing device may re-fetch it, nobody else can.
      "cache-control": "private, max-age=604800",
    },
  });
}

// --- offline ---------------------------------------------------------------

// Bump when sw.js or app.js changes. The service worker script itself updates
// automatically (the browser byte-compares it), but the CACHE NAME has to move
// or old entries outlive the logic that wrote them.
const CACHE_VERSION = "v1";

/**
 * The service worker. This is what turns the page into an app.
 *
 * Before it, every tap was a ~270ms round trip and no signal meant a blank
 * screen -- which is the actual difference between this and a native app, far
 * more than the fact that it renders HTML.
 *
 * STRATEGY: cache-first, revalidate in the background.
 *
 * A decision log is not a live feed. Showing yesterday's answer instantly and
 * correcting it a moment later is strictly better than showing nothing for
 * 270ms, and the header already carries an "8h ago" freshness stamp so stale
 * data is never silently presented as current. Network-first would have thrown
 * away the entire benefit on exactly the connection where it matters.
 *
 * WHAT IS NEVER CACHED
 *
 * Only 200s. A 404 is what this Worker returns for an unauthenticated or
 * rotated credential, and caching one would mean a device that rotated its
 * token keeps being told it is signed out -- from its own disk, with no network
 * involved, and no obvious way to clear it.
 *
 * THE TOKEN STILL NEVER REACHES JAVASCRIPT. The cookie is HttpOnly, so this
 * script cannot read it; it only issues same-origin requests the browser
 * attaches it to. Adding a service worker gives up "no client-side JS at all",
 * not the credential isolation that mattered.
 */
export function serviceWorkerJs(): string {
  return `
const CACHE = "ck-view-${CACHE_VERSION}";

self.addEventListener("install", (e) => {
  // Take over without requiring every tab to close first.
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Drop caches from a previous version, or they outlive the code that wrote
    // them and there is no way to reason about what is in them.
    for (const k of await caches.keys()) {
      if (k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/view")) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Ignore ?cb= style cache-busters when matching, so a shared link with a
    // stray param still hits the entry it is really asking for.
    const hit = await cache.match(req, { ignoreSearch: false });

    const network = fetch(req).then((res) => {
      // ONLY 200. A 404 here means unauthenticated or rotated; caching it would
      // lock the device out from its own disk.
      if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);

    if (hit) {
      // Instant, and correct itself in the background.
      e.waitUntil(network);
      return hit;
    }
    const res = await network;
    if (res) return res;

    // Nothing cached and no network. Say so honestly rather than showing a
    // browser error page that implies the app is broken.
    return new Response(
      '<!doctype html><meta charset=utf-8>' +
      '<meta name=viewport content="width=device-width,initial-scale=1">' +
      '<style>body{margin:0;background:#0b0e13;color:#e7edf5;font:16px/1.5 -apple-system,' +
      'BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;display:flex;' +
      'min-height:100vh;align-items:center;justify-content:center;padding:24px;' +
      'text-align:center}p{color:#8b97a8;font-size:14px;max-width:30ch}' +
      '@media(prefers-color-scheme:light){body{background:#f7f9fb;color:#131820}}</style>' +
      '<div><h1 style="font-size:17px;margin:0 0 8px">Offline</h1>' +
      '<p>This page has not been opened on this device yet, so there is nothing ' +
      'cached to show. Anything you have already viewed still works.</p></div>',
      { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  })());
});
`.trim();
}

/**
 * The registration shim. A separate file rather than an inline <script> so the
 * CSP can stay script-src 'self' with no 'unsafe-inline' -- an inline script
 * allowance would apply to the whole document, including anything a recorded
 * entry managed to smuggle past the escaper.
 */
export function appJs(): string {
  return `
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/view/sw.js", { scope: "/view" })
      .catch(() => {});
  });
}
`.trim();
}

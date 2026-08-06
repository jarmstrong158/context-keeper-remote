// Worker entry point.
//
// Request lifecycle: match POST /mcp/:token -> constant-time token check ->
// dispatch to the stateless MCP handler. Anything that does not match a valid
// token URL returns a bare 404: the URL is the credential, so we never confirm
// or deny why a request failed.
//
// D1 migrations are NOT run here. The initialize/ping/tools-list handshake must
// never block on a D1 round-trip -- that is what makes a cold-start handshake
// slow enough for a reconnecting client to drop. Instead the schema is ensured
// lazily inside the first tools/call (see ctx.ready below), memoized per
// isolate, so the handshake is pure protocol and answers instantly.

import { runMigrations } from "./db";
import { McpServer, createMcpHandler, type ToolContext } from "./mcp";
import { pathTokenMatches } from "./shared/mcp-core";
import { ALL_TOOLS } from "./tools";
import { log } from "./log";
import { renderView } from "./view";
import {
  appJs, cookieAuthorised, iconResponse, manifestJson, serviceWorkerJs, sessionCookie,
} from "./install";

const server = new McpServer({ name: "context-keeper-remote", version: "1.0.0" });
server.registerAll(ALL_TOOLS);

const mcpHandler = createMcpHandler(server);

// Bare 404 with no body — do not leak whether the path or token was the issue.
function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

// Token comparison lives in src/shared/mcp-core.ts (pathTokenMatches), shared
// byte-identically with agentsync-remote and cambium-remote. It percent-decodes
// the segment, contains the URIError a malformed escape like /mcp/%zz used to
// throw from OUTSIDE the try block below, and compares in time independent of
// BOTH the content and the length of the two strings.

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Expect exactly /mcp/<token>. Extra path segments are rejected.
    const match = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    // ...and exactly /view/<token>, a read-only HTML render on its OWN secret.
    // Separate credential by design: this URL gets opened on a phone, and the
    // connector token is read/write over every project (see src/view.ts).
    const view = /^\/view\/([^/]+)\/?$/.exec(url.pathname);

    // The installable surface. Three ways in, one credential behind all of them:
    //
    //   /view/<VIEW_TOKEN>  enrol   - proves possession, hands back a cookie
    //   /view               use     - the cookie proves it; what the icon opens
    //   /view/icon.png etc  assets  - cookie only, never a token in the URL
    //
    // Order matters: the literal asset paths also match /^\/view\/([^/]+)$/, so
    // they must be handled before that pattern treats "icon.png" as a token and
    // 404s the icon of an app that is otherwise working.
    // sw.js and app.js join the asset set. The service worker is what makes this
    // an app rather than a page: without it every tap is a network round trip
    // and no signal means a blank screen.
    //
    // sw.js is served with Cache-Control: no-cache deliberately. The browser
    // byte-compares the script to decide whether to install an update, and a
    // cached copy would pin users to whichever version they first received --
    // the one bug class a service worker cannot recover from on its own.
    if (
      url.pathname === "/view/icon.png" ||
      url.pathname === "/view/icon-192.png" ||
      url.pathname === "/view/manifest.webmanifest" ||
      url.pathname === "/view/sw.js" ||
      url.pathname === "/view/app.js"
    ) {
      log("request", { route: url.pathname, method: request.method });
      // Assets authenticate on the cookie alone. The <link rel="manifest"> in
      // the page carries crossorigin="use-credentials" so the browser sends it.
      const ok = await cookieAuthorised(request, env.VIEW_TOKEN);
      log("auth", { ok, surface: "view-asset" });
      if (!ok) return notFound();
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      if (url.pathname === "/view/icon.png") return iconResponse(512);
      if (url.pathname === "/view/icon-192.png") return iconResponse(192);
      if (url.pathname === "/view/sw.js" || url.pathname === "/view/app.js") {
        const body = url.pathname === "/view/sw.js" ? serviceWorkerJs() : appJs();
        return new Response(body, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            // no-cache, not no-store: the browser may keep a copy but must
            // revalidate, which is what lets a service worker update at all.
            "cache-control": "no-cache",
            // A service worker's scope is capped by the path it is served from
            // unless this header widens it. Served from /view/, /view is the
            // natural scope, so this is belt and braces -- but a scope mismatch
            // fails registration silently, which is the worst way to find out.
            "service-worker-allowed": "/view",
          },
        });
      }
      return new Response(manifestJson(), {
        headers: {
          "content-type": "application/manifest+json; charset=utf-8",
          "cache-control": "private, max-age=3600",
        },
      });
    }

    // /view and /view/ -- the installed entry point, cookie-authenticated.
    const viewBare = url.pathname === "/view" || url.pathname === "/view/";

    if (view || viewBare) {
      log("request", { route: view ? "/view/***" : "/view", method: request.method });
      // VIEW_TOKEN unset => the feature is off => indistinguishable from any
      // other unknown path. Never falls back to AUTH_TOKEN: a second credential
      // that silently accepts the first is not a second credential.
      //
      // A token in the path is what enrols a device; a cookie is what a device
      // presents afterwards. Both compare against the same secret, so rotating
      // VIEW_TOKEN revokes every device at once and there is no second
      // revocation path to forget about.
      const enrolling = Boolean(view);
      const viewOk = enrolling
        ? await pathTokenMatches(view![1], env.VIEW_TOKEN)
        : await cookieAuthorised(request, env.VIEW_TOKEN);
      log("auth", { ok: viewOk, surface: "view", enrolling });
      if (!viewOk) return notFound();
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      try {
        await runMigrations(env.DB);
        // Query params drive detail / project / search pages. They hang off this
        // same path so they inherit this one cookie check rather than adding a
        // second auth surface that can drift out of step.
        const html = await renderView(
          env.DB,
          env.CAMBIUM_STATUS_URL,
          url.searchParams,
          (env as { CAMBIUM?: { fetch: typeof fetch } }).CAMBIUM,
        );
        const headers: Record<string, string> = {
          "content-type": "text/html; charset=utf-8",
          // Behind a secret: never store it, never let a shared cache hold it.
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
          "x-robots-tag": "noindex, nofollow",
          // The page loads its own icon and manifest now, so 'none' no longer
          // covers it. Still no script, no network, no framing, no forms.
          "content-security-policy":
            // form-action 'self' is new: the search box is a GET form posting back
          // to /view. Everything else stays shut -- still no script, no network,
          // no framing.
          // script-src 'self' is new, for app.js and the service worker.
          // Deliberately NOT 'unsafe-inline': the registration lives in its own
          // file precisely so an inline allowance -- which would apply to the
          // whole document, including anything a recorded entry smuggled past
          // the escaper -- is never needed. worker-src is required separately;
          // script-src does not cover service worker registration.
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; " +
            "script-src 'self'; worker-src 'self'; connect-src 'self'; " +
            "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        };
        // Re-issued on every enrolling visit, which also refreshes the ten-year
        // window -- so a device that keeps being used never has to be re-enrolled.
        if (enrolling) headers["set-cookie"] = sessionCookie(view![1]);
        return new Response(request.method === "HEAD" ? null : html, { headers });
      } catch (err) {
        log("error", {
          surface: "view",
          message: err instanceof Error ? err.message : String(err),
        });
        return new Response("view unavailable", { status: 500 });
      }
    }

    // The path token is the credential -> log the route with it redacted.
    log("request", {
      route: match ? "/mcp/***" : url.pathname,
      method: request.method,
    });

    if (!match) return notFound();

    // Missing/empty secret => nothing authenticates => always 404.
    const ok = await pathTokenMatches(match[1], env.AUTH_TOKEN);
    log("auth", { ok });
    if (!ok) return notFound();

    // Token is valid. Only POST is a real MCP request; other methods 405.
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }

    // ready(): ensure the D1 schema exists. Invoked lazily by the MCP handler
    // only for tools/call -- NOT on the handshake -- and memoized per isolate
    // inside runMigrations, so it costs one round-trip on the first tool call of
    // a cold isolate and nothing thereafter. A migration failure surfaces as a
    // tool isError, never as a handshake-time 500.
    const ctx: ToolContext = {
      db: env.DB,
      env,
      ready: () => runMigrations(env.DB),
    };

    try {
      return await mcpHandler(request, ctx);
    } catch (err) {
      // Defence in depth: an unexpected throw must not become a bare 500 a
      // reconnecting client reads as a hard failure.
      log("error", {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return Response.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "internal error" },
      });
    }
  },
};

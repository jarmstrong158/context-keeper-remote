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

    if (view) {
      log("request", { route: "/view/***", method: request.method });
      // VIEW_TOKEN unset => the feature is off => indistinguishable from any
      // other unknown path. Never falls back to AUTH_TOKEN: a second credential
      // that silently accepts the first is not a second credential.
      const viewOk = await pathTokenMatches(view[1], env.VIEW_TOKEN);
      log("auth", { ok: viewOk, surface: "view" });
      if (!viewOk) return notFound();
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      try {
        await runMigrations(env.DB);
        const html = await renderView(env.DB, env.CAMBIUM_STATUS_URL);
        return new Response(request.method === "HEAD" ? null : html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            // Behind a secret: never store it, never let a shared cache hold it.
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
            "x-robots-tag": "noindex, nofollow",
            // Nothing here loads or executes anything; say so.
            "content-security-policy":
              "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
          },
        });
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

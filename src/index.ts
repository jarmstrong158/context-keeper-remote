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

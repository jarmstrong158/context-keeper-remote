// Conformance tests for MCP protocol revision 2026-07-28.
//
// This Worker is hand-rolled (see the note at the top of src/mcp.ts), so these
// tests are load-bearing: nothing else checks the wire shape.
//
// It is deliberately DUAL-ERA. The legacy assertions matter as much as the
// modern ones: the desktop context-keeper's mirror and any already-configured
// client speak the handshake era until they are upgraded, and legacy clients
// have no fall-forward mechanism.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { TOKEN } from "./helpers";

const ORIGIN = "https://worker.example.com";
const MODERN = "2026-07-28";

let idCounter = 1000;

/** POST a request as a MODERN client: per-request `_meta` plus the standard
 *  Streamable HTTP headers a 2026-07-28 server requires. */
async function modernRpc(
  method: string,
  params: Record<string, unknown> = {},
  opts: {
    version?: string;
    headerVersion?: string;
    mcpMethod?: string;
    mcpName?: string;
    omit?: ("version" | "method" | "name")[];
  } = {},
): Promise<any> {
  const version = opts.version ?? MODERN;
  const omit = opts.omit ?? [];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (!omit.includes("version")) {
    headers["mcp-protocol-version"] = opts.headerVersion ?? version;
  }
  if (!omit.includes("method")) headers["mcp-method"] = opts.mcpMethod ?? method;

  const name = typeof params.name === "string" ? params.name : null;
  if (name && !omit.includes("name")) headers["mcp-name"] = opts.mcpName ?? name;

  const res = await SELF.fetch(`${ORIGIN}/mcp/${TOKEN}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++idCounter,
      method,
      params: {
        ...params,
        _meta: { "io.modelcontextprotocol/protocolVersion": version },
      },
    }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** POST as a LEGACY client: no `_meta`, no 2026-07-28 headers. */
async function legacyRpc(method: string, params?: unknown): Promise<any> {
  const res = await SELF.fetch(`${ORIGIN}/mcp/${TOKEN}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++idCounter, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("2026-07-28 modern era", () => {
  it("implements server/discover", async () => {
    // MUST as of this revision.
    const { body } = await modernRpc("server/discover");
    expect(body.result.supportedVersions).toContain(MODERN);
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: expect.any(String),
    });
  });

  it("answers server/discover to a legacy probe", async () => {
    // A dual-era client may probe before it knows the server's era.
    const { body } = await legacyRpc("server/discover");
    expect(body.result.supportedVersions).toContain(MODERN);
  });

  it.each(["tools/list", "server/discover"])(
    "returns ttlMs and cacheScope on %s",
    async (method) => {
      // SEP-2549. The catalogue is static code identical for every caller.
      const { body } = await modernRpc(method);
      expect(body.result.ttlMs).toBe(300_000);
      expect(body.result.cacheScope).toBe("public");
    },
  );

  it("stamps resultType and serverInfo on every result", async () => {
    const { body } = await modernRpc("tools/list");
    expect(body.result.resultType).toBe("complete");
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"]).toBeDefined();
  });

  it("returns tools in a deterministic order", async () => {
    const a = await modernRpc("tools/list");
    const b = await modernRpc("tools/list");
    expect(a.body.result.tools.map((t: any) => t.name)).toEqual(
      b.body.result.tools.map((t: any) => t.name),
    );
  });

  it("rejects an unsupported protocol version with the supported list", async () => {
    const { body } = await modernRpc("tools/list", {}, { version: "1999-01-01" });
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain(MODERN);
    expect(body.error.data.requested).toBe("1999-01-01");
  });
});

describe("2026-07-28 request headers", () => {
  // The spec mirrors body fields into headers so gateways can route without
  // parsing the body, and REQUIRES the server to reject disagreement -- else a
  // gateway routing on the header and the server executing on the body can be
  // made to disagree deliberately.

  it("rejects a missing MCP-Protocol-Version header", async () => {
    const { body } = await modernRpc("tools/list", {}, { omit: ["version"] });
    expect(body.error.code).toBe(-32020);
  });

  it("rejects a missing Mcp-Method header", async () => {
    const { body } = await modernRpc("tools/list", {}, { omit: ["method"] });
    expect(body.error.code).toBe(-32020);
  });

  it("rejects a header/body protocol version mismatch", async () => {
    const { body } = await modernRpc("tools/list", {}, { headerVersion: "2025-06-18" });
    expect(body.error.code).toBe(-32020);
  });

  it("rejects an Mcp-Method that disagrees with the body", async () => {
    const { body } = await modernRpc("tools/list", {}, { mcpMethod: "tools/call" });
    expect(body.error.code).toBe(-32020);
  });

  it("rejects an Mcp-Name that disagrees with the body", async () => {
    const { body } = await modernRpc(
      "tools/call",
      { name: "query_entries", arguments: {} },
      { mcpName: "upsert_entries" },
    );
    expect(body.error.code).toBe(-32020);
  });

  it("accepts a Base64-encoded Mcp-Name", async () => {
    // Names outside the header-safe set travel as =?base64?...?=, and the
    // server must decode before comparing.
    const encoded = `=?base64?${btoa("query_entries")}?=`;
    const { body } = await modernRpc(
      "tools/call",
      { name: "query_entries", arguments: { project: "test", limit: 1 } },
      { mcpName: encoded },
    );
    expect(body.error?.code).not.toBe(-32020);
  });
});

describe("legacy era is untouched", () => {
  it("still answers the initialize handshake", async () => {
    const { body } = await legacyRpc("initialize", { protocolVersion: "2025-06-18" });
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo).toBeDefined();
  });

  it("does not leak modern fields into legacy responses", async () => {
    // A legacy client must see exactly what it saw before the migration.
    const { body } = await legacyRpc("tools/list");
    expect(Object.keys(body.result)).toEqual(["tools"]);
  });

  it("does not require the new headers from a legacy client", async () => {
    // Those headers did not exist in the handshake era; demanding them would
    // break every already-configured client at once.
    const { body } = await legacyRpc("tools/list");
    expect(body.error).toBeUndefined();
  });
});

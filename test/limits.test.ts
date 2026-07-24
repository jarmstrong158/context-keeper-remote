// Request-size and cardinality limits.
//
// These tools write to D1 on behalf of whoever holds the path token, and until
// now nothing bounded how much: upsert_entries took an unbounded array, the
// record tools were `.loose()` with no length bound on any field, and every
// stored entry is read back by get_context/query_entries into a model's context
// window. An unbounded write is both a storage problem and a context-pollution
// problem, and neither announced itself -- the write just succeeded.

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { MAX_BATCH_ENTRIES, MAX_NAME_LENGTH, MAX_TEXT_LENGTH } from "../src/tools/common";
import { TOKEN, callToolRaw, rpcJson } from "./helpers";

let seq = 0;
const project = () => `limits-${++seq}`;

describe("field length limits", () => {
  it("rejects an over-long free-text field with an invalid-params error", async () => {
    const { body } = await rpcJson("tools/call", {
      name: "record_entry",
      arguments: {
        kind: "decision",
        project: project(),
        summary: "x".repeat(MAX_TEXT_LENGTH + 1),
      },
    });
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/summary/);
  });

  it("rejects an over-long project name", async () => {
    const { body } = await rpcJson("tools/call", {
      name: "record_entry",
      arguments: { kind: "decision", project: "p".repeat(MAX_NAME_LENGTH + 1), summary: "s" },
    });
    expect(body.error.code).toBe(-32602);
  });

  it("still accepts a normal-sized entry", async () => {
    const body = await callToolRaw("record_entry", {
      kind: "decision",
      project: project(),
      summary: "Use D1 rather than KV for the rationale store.",
      why_chosen: "Relational queries over entries are the whole point.",
    });
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(false);
  });
});

describe("loose-schema payload bound", () => {
  it("bounds the total payload, which per-field caps cannot reach", async () => {
    // The record schemas are `.loose()` so the local store's shape can evolve
    // without a Worker redeploy. That means unrecognised keys pass straight
    // through, so any number of them, of any size, used to be storable.
    const extras: Record<string, unknown> = {
      kind: "decision",
      project: project(),
      summary: "s",
    };
    for (let i = 0; i < 40; i++) extras[`extra_${i}`] = "y".repeat(5000);

    const body = await callToolRaw("record_entry", extras);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/over the \d+-byte limit/);
  });
});

describe("batch cardinality limits", () => {
  it("rejects an oversized upsert_entries batch instead of half-applying it", async () => {
    // A batch large enough to exhaust the Worker's CPU/subrequest budget partway
    // through leaves the mirror half-applied, and the caller cannot tell which
    // ids landed. A clean rejection is strictly better.
    const entries = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => ({
      id: `d-${i}`,
      summary: "s",
      updated_at: "2026-01-01T00:00:00Z",
    }));
    const { body } = await rpcJson("tools/call", {
      name: "upsert_entries",
      arguments: { project: project(), kind: "decision", entries },
    });
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/entries/);
  });

  it("accepts a batch at the documented size", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `ok-${i}`,
      summary: "s",
      updated_at: "2026-01-01T00:00:00Z",
    }));
    const body = await callToolRaw("upsert_entries", {
      project: project(),
      kind: "decision",
      entries,
    });
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(false);
  });
});

describe("transport limits", () => {
  it("rejects an oversized request body", async () => {
    const res = await SELF.fetch(`https://w.example.com/mcp/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1_100_000) }),
    });
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/too large/);
  });

  it("rejects an oversized JSON-RPC batch", async () => {
    const batch = Array.from({ length: 65 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    const res = await SELF.fetch(`https://w.example.com/mcp/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/Batch too large/);
  });
});

describe("protocol negotiation", () => {
  it("does not echo an unsupported protocolVersion", async () => {
    const { body } = await rpcJson("initialize", { protocolVersion: "banana" });
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("agrees to a supported older revision", async () => {
    const { body } = await rpcJson("initialize", { protocolVersion: "2024-11-05" });
    expect(body.result.protocolVersion).toBe("2024-11-05");
  });
});

describe("path-token handling", () => {
  it("answers 404, not 500, on a malformed percent-escape", async () => {
    // decodeURIComponent("%zz") throws URIError, and that call sat OUTSIDE
    // index.ts's try block -- an uncaught 500 that also served as an oracle.
    const res = await SELF.fetch("https://w.example.com/mcp/%zz", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("rejects an absurdly long token", async () => {
    const res = await SELF.fetch(`https://w.example.com/mcp/${"x".repeat(5000)}`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});

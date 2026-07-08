import { it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { callTool } from "./helpers";

// A "Deploy to Cloudflare" self-hoster gets a freshly auto-provisioned, EMPTY
// D1 with no tables. This verifies the Worker's runtime migrations mean that
// database needs no manual SQL: the very first tool call creates the schema and
// succeeds. Runs in its own test file so the isolate (and the per-isolate
// migration memo) starts clean.

beforeAll(async () => {
  // Simulate a brand-new database: remove any schema this shared workerd D1 may
  // already carry. DROP TABLE also drops the table's indexes.
  await env.DB.prepare("DROP TABLE IF EXISTS entries").run();
  await env.DB.prepare("DROP TABLE IF EXISTS config").run();
});

it("first request to an empty database auto-creates the schema (no manual SQL)", async () => {
  // Precondition: the store table really is absent.
  const before = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='entries'",
  ).first<{ name: string }>();
  expect(before).toBeNull();

  // First-ever call: the Worker migrates itself, then serves the request.
  const rec = await callTool("record_decision", {
    project: "cold-start",
    summary: "works from a cold, empty database",
  });
  expect(rec.id).toBe("dec-001");

  // The schema now exists and the row round-trips.
  const after = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='entries'",
  ).first<{ name: string }>();
  expect(after?.name).toBe("entries");

  const q = await callTool("query_entries", { project: "cold-start", id: "dec-001" });
  expect(q.count).toBe(1);
});

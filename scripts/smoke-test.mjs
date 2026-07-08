#!/usr/bin/env node
// End-to-end smoke test against a LIVE deployed worker.
//
//   WORKER_URL="https://<worker>.<account>.workers.dev/mcp/<AUTH_TOKEN>" \
//     node scripts/smoke-test.mjs
//
// The URL includes the secret token (the URL is the credential). This is NOT
// runnable inside the build container (no egress to the worker); run it from
// any machine once the worker is deployed.
//
// It exercises: initialize -> tools/list -> record_decision -> query_entries,
// using a throwaway project so it doesn't pollute real data.

const WORKER_URL = process.env.WORKER_URL;
if (!WORKER_URL) {
  console.error("Set WORKER_URL to https://<worker>.<account>.workers.dev/mcp/<AUTH_TOKEN>");
  process.exit(2);
}

let idCounter = 0;

async function rpc(method, params) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++idCounter, method, params }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${method}: ${await res.text()}`);
  }
  const body = await res.json();
  if (body.error) throw new Error(`RPC error for ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function callTool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) {
    throw new Error(`tool ${name} failed: ${result.content?.[0]?.text}`);
  }
  return result.structuredContent;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  const project = `smoke-${Date.now()}`;

  console.log("1. initialize");
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert(init.serverInfo?.name === "context-keeper-remote", "serverInfo.name is context-keeper-remote");

  console.log("2. tools/list");
  const list = await rpc("tools/list", {});
  const names = list.tools.map((t) => t.name);
  assert(names.includes("record_decision"), "record_decision is listed");
  assert(names.includes("query_entries"), "query_entries is listed");
  assert(names.includes("import_entries"), "import_entries is listed");

  console.log(`3. record_decision (project ${project})`);
  const rec = await callTool("record_decision", {
    project,
    summary: "Smoke test decision",
    why_chosen: "verifying the live round-trip",
    tags: ["smoke"],
  });
  assert(rec.id === "dec-001", `first decision id is dec-001 (got ${rec.id})`);

  console.log("4. query_entries round-trip");
  const q = await callTool("query_entries", { project, id: "dec-001" });
  assert(q.count === 1, "query finds the decision");
  assert(q.results[0].payload.summary === "Smoke test decision", "payload round-trips");

  console.log(`\nAll smoke checks passed. (Test data left under project '${project}'.)`);
}

main().catch((err) => {
  console.error(`\nSMOKE TEST FAILED: ${err.message}`);
  process.exit(1);
});

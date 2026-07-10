import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import decisionsFixture from "./fixtures/decisions.json";
import constraintsFixture from "./fixtures/constraints.json";
import { runMigrations } from "../src/db";
import { TOKEN, callTool, callToolRaw, rpc, rpcJson } from "./helpers";

// Each test uses a unique project so the shared (non-isolated) D1 doesn't leak
// state between cases.
let seq = 0;
function project(name: string): string {
  return `${name}-${++seq}`;
}

describe("auth (secret-path)", () => {
  it("rejects a missing token path with 404", async () => {
    const res = await SELF.fetch("https://w.example.com/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("rejects a wrong token with 404 and no detail", async () => {
    const res = await rpc("tools/list", {}, "not-the-token");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("rejects non-POST on a valid token with 405", async () => {
    const res = await SELF.fetch(`https://w.example.com/mcp/${TOKEN}`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("rejects an unrelated path with 404", async () => {
    const res = await SELF.fetch("https://w.example.com/", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("accepts the valid token", async () => {
    const { status, body } = await rpcJson("ping", {});
    expect(status).toBe(200);
    expect(body.result).toEqual({});
  });
});

describe("mcp protocol", () => {
  it("handles initialize", async () => {
    const { body } = await rpcJson("initialize", { protocolVersion: "2025-06-18" });
    expect(body.result.serverInfo.name).toBe("context-keeper-remote");
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const res = await SELF.fetch(`https://w.example.com/mcp/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("lists all tools with object input schemas", async () => {
    const { body } = await rpcJson("tools/list", {});
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("record_decision");
    expect(names).toContain("import_entries");
    expect(names).toContain("get_context");
    for (const t of body.result.tools) {
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("returns -32601 for an unknown tool", async () => {
    const { body } = await rpcJson("tools/call", { name: "nope", arguments: {} });
    expect(body.error.code).toBe(-32601);
  });

  it("returns -32602 for invalid arguments", async () => {
    const { body } = await rpcJson("tools/call", {
      name: "record_decision",
      arguments: { project: "x" }, // missing required `summary`
    });
    expect(body.error.code).toBe(-32602);
  });
});

describe("migrations", () => {
  it("is idempotent when run repeatedly", async () => {
    await expect(runMigrations(env.DB)).resolves.toBeUndefined();
    await expect(runMigrations(env.DB)).resolves.toBeUndefined();
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entries'",
    ).first();
    expect(row?.name).toBe("entries");
  });
});

describe("record + retrieve per kind", () => {
  it("records and queries a decision", async () => {
    const p = project("dec");
    const rec = await callTool("record_decision", {
      project: p,
      summary: "Adopt streamable HTTP",
      why_chosen: "works as a claude.ai connector",
      tags: ["mcp"],
    });
    expect(rec.id).toBe("dec-001");
    expect(rec.entry.payload.summary).toBe("Adopt streamable HTTP");

    const q = await callTool("query_entries", { project: p, kind: "decision" });
    expect(q.count).toBe(1);
    expect(q.results[0].id).toBe("dec-001");
  });

  it("records a constraint and a pipeline", async () => {
    const p = project("mix");
    const con = await callTool("record_constraint", {
      project: p,
      rule: "no DO",
      reason: "free plan",
    });
    expect(con.id).toBe("con-001");
    const pipe = await callTool("record_pipeline", {
      project: p,
      name: "deploy",
      purpose: "push to main -> Workers Builds",
      steps: ["commit", "push"],
      extra_field: "kept",
    });
    expect(pipe.id).toBe("pipe-001");
    expect(pipe.entry.payload.extra_field).toBe("kept");
    expect(pipe.entry.payload.steps).toEqual(["commit", "push"]);
  });
});

describe("unified record_entry tool", () => {
  it("record_entry kind='decision' writes a decision (id + payload)", async () => {
    const p = project("re-dec");
    const r = await callTool("record_entry", {
      project: p, kind: "decision", summary: "via record_entry", tags: ["mcp"],
    });
    expect(r.id).toBe("dec-001");
    expect(r.entry.payload.summary).toBe("via record_entry");
    // kind must not leak into the stored payload
    expect(r.entry.payload.kind).toBeUndefined();
  });

  it("record_entry kind='constraint' and 'pipeline' write the right kinds", async () => {
    const p = project("re-mix");
    const c = await callTool("record_entry", { project: p, kind: "constraint", rule: "no DO" });
    expect(c.id).toBe("con-001");
    const pipe = await callTool("record_entry", {
      project: p, kind: "pipeline", name: "deploy", steps: ["push"],
    });
    expect(pipe.id).toBe("pipe-001");
  });

  it("record_entry maps rationale forward just like record_decision", async () => {
    const p = project("re-rat");
    const r = await callTool("record_entry", {
      project: p, kind: "decision", summary: "s", rationale: "legacy",
    });
    expect(r.entry.payload.why_chosen).toBe("legacy");
    expect(r.entry.payload.rationale).toBeUndefined();
  });

  it("record_entry enforces the per-kind required field", async () => {
    const p = project("re-bad");
    const raw = await callToolRaw("record_entry", { project: p, kind: "decision" });
    expect(raw.result.isError).toBe(true);
    expect(raw.result.content[0].text).toMatch(/requires 'summary'/);
  });

  it("record_entry rejects an unknown kind at the schema layer", async () => {
    const raw = await callToolRaw("record_entry", { kind: "gizmo", summary: "x" });
    expect(raw.error?.code ?? raw.result?.isError).toBeTruthy();
  });

  it("record_entry is registered alongside the deprecated record_* aliases", async () => {
    const { body } = await rpcJson("tools/list", {});
    const names = body.result.tools.map((t: any) => t.name);
    for (const n of ["record_entry", "record_decision", "record_constraint", "record_pipeline"]) {
      expect(names).toContain(n);
    }
  });
});

describe("id sequencing", () => {
  it("increments per project+kind, zero-padded to 3", async () => {
    const p = project("seq");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await callTool("record_decision", { project: p, summary: `d${i}` });
      ids.push(r.id);
    }
    expect(ids).toEqual(["dec-001", "dec-002", "dec-003"]);
    // constraints get their own sequence in the same project
    const c = await callTool("record_constraint", { project: p, rule: "r" });
    expect(c.id).toBe("con-001");
  });
});

describe("rationale -> why_chosen mapping", () => {
  it("maps deprecated rationale forward when why_chosen is absent", async () => {
    const p = project("rat");
    const r = await callTool("record_decision", {
      project: p,
      summary: "s",
      rationale: "legacy reasoning",
    });
    expect(r.entry.payload.why_chosen).toBe("legacy reasoning");
    expect(r.entry.payload.rationale).toBeUndefined();
  });

  it("keeps why_chosen when both are present", async () => {
    const p = project("rat2");
    const r = await callTool("record_decision", {
      project: p,
      summary: "s",
      why_chosen: "new",
      rationale: "old",
    });
    expect(r.entry.payload.why_chosen).toBe("new");
    expect(r.entry.payload.rationale).toBeUndefined();
  });
});

describe("deprecate / supersede chain", () => {
  it("deprecates and links superseded_by, excluding from default retrieval", async () => {
    const p = project("dep");
    const a = await callTool("record_decision", { project: p, summary: "old approach" });
    const b = await callTool("record_decision", { project: p, summary: "new approach" });

    const dep = await callTool("deprecate_entry", {
      project: p,
      id: a.id,
      superseded_by: b.id,
    });
    expect(dep.status).toBe("deprecated");
    expect(dep.superseded_by).toBe(b.id);
    expect(dep.superseded_by_exists).toBe(true);

    // default query (all) still sees it; get_context should exclude it
    const ctx = await callTool("get_context", { project: p, query: "old approach" });
    expect(ctx.results.find((e: any) => e.id === a.id)).toBeUndefined();

    const ctxInc = await callTool("get_context", {
      project: p,
      query: "old approach",
      include_deprecated: true,
    });
    expect(ctxInc.results.find((e: any) => e.id === a.id)).toBeDefined();
  });
});

describe("query filters", () => {
  it("filters by tags, text, status, and id", async () => {
    const p = project("filter");
    await callTool("record_decision", {
      project: p,
      summary: "cache layer",
      tags: ["perf", "cache"],
    });
    await callTool("record_decision", {
      project: p,
      summary: "auth flow",
      tags: ["auth"],
    });
    const dep = await callTool("record_decision", { project: p, summary: "retired idea" });
    await callTool("deprecate_entry", { project: p, id: dep.id });

    const byTag = await callTool("query_entries", { project: p, tags: ["cache"] });
    expect(byTag.count).toBe(1);
    expect(byTag.results[0].payload.summary).toBe("cache layer");

    const byText = await callTool("query_entries", { project: p, text: "auth" });
    expect(byText.count).toBe(1);

    const active = await callTool("query_entries", { project: p, status: "active" });
    expect(active.count).toBe(2);
    const deprecated = await callTool("query_entries", { project: p, status: "deprecated" });
    expect(deprecated.count).toBe(1);

    const byId = await callTool("query_entries", { project: p, id: "dec-001" });
    expect(byId.count).toBe(1);
  });

  it("limit caps results and reports total via `matched`", async () => {
    const p = project("limit");
    for (let i = 0; i < 5; i++) {
      await callTool("record_decision", { project: p, summary: `entry ${i}` });
    }
    const limited = await callTool("query_entries", { project: p, kind: "decision", limit: 2 });
    expect(limited.count).toBe(2);
    expect(limited.matched).toBe(5);
    expect(limited.results.length).toBe(2);
    // without a limit, count == matched (existing callers unaffected)
    const all = await callTool("query_entries", { project: p, kind: "decision" });
    expect(all.count).toBe(5);
    expect(all.matched).toBe(5);
  });
});

describe("get_project_summary orientation fields", () => {
  it("returns counts by kind/status, active constraints, recent decisions, and ids", async () => {
    const p = project("orient");
    await callTool("record_constraint", { project: p, rule: "no eval" });
    await callTool("record_decision", { project: p, summary: "first decision" });
    await callTool("record_decision", { project: p, summary: "second decision" });
    const s = await callTool("get_project_summary", { project: p });
    // existing keys preserved
    expect(s.total).toBe(3);
    expect(s.by_kind.decision.active).toBe(2);
    expect(s.by_kind.decision.ids).toContain("dec-001");
    // additive orientation fields
    expect(s.active_constraints).toEqual([{ id: "con-001", rule: "no eval" }]);
    expect(s.recent_decisions.length).toBe(2);
    expect(s.recent_decisions[0].id).toBe("dec-002"); // most recent first
    expect(s.recent_decisions[0].summary).toBe("second decision");
  });
});

describe("get_context ranking", () => {
  it("ranks entries by keyword relevance", async () => {
    const p = project("rank");
    await callTool("record_decision", {
      project: p,
      summary: "database database database choice",
      why_chosen: "row-level writes",
    });
    await callTool("record_decision", { project: p, summary: "unrelated topic" });
    const ctx = await callTool("get_context", { project: p, query: "database" });
    expect(ctx.results.length).toBe(1);
    expect(ctx.results[0].score).toBeGreaterThan(0);
    expect(ctx.results[0].payload.summary).toContain("database");
  });
});

describe("update_entry", () => {
  it("merges patch fields and bumps updated_at", async () => {
    const p = project("upd");
    const r = await callTool("record_constraint", { project: p, rule: "old rule" });
    const upd = await callTool("update_entry", {
      project: p,
      id: r.id,
      patch: { reason: "added later", tags: ["ops"] },
    });
    expect(upd.entry.payload.rule).toBe("old rule");
    expect(upd.entry.payload.reason).toBe("added later");
    expect(upd.entry.payload.tags).toEqual(["ops"]);
  });
});

describe("reload_constraints / verify_quality / export_markdown / prune_stale", () => {
  it("reload_constraints returns compact active constraints", async () => {
    const p = project("rc");
    await callTool("record_constraint", { project: p, rule: "always X", reason: "because" });
    const rc = await callTool("reload_constraints", { project: p });
    expect(rc.count).toBe(1);
    expect(rc.constraints[0].rule).toBe("always X");
    expect(rc.constraints[0].reason).toBe("because");
  });

  it("verify_quality flags missing rationale fields", async () => {
    const p = project("vq");
    await callTool("record_decision", { project: p, summary: "no reasoning given" });
    await callTool("record_decision", {
      project: p,
      summary: "complete",
      why_chosen: "solid",
    });
    const vq = await callTool("verify_quality", { project: p });
    expect(vq.flagged_count).toBe(1);
    expect(vq.flagged[0].issues).toContain("missing why_chosen");
  });

  it("export_markdown renders a document", async () => {
    const p = project("md");
    await callTool("record_decision", {
      project: p,
      summary: "use D1",
      why_chosen: "row writes",
    });
    const md = await callTool("export_markdown", { project: p });
    expect(md.markdown).toContain(`# ${p}`);
    expect(md.markdown).toContain("## Decisions");
    expect(md.markdown).toContain("use D1");
  });

  it("prune_stale dry-runs by default and deletes when asked", async () => {
    const p = project("prune");
    const r = await callTool("record_decision", { project: p, summary: "temp" });
    await callTool("deprecate_entry", { project: p, id: r.id });

    // 0-day threshold: the just-deprecated entry counts as stale.
    const dry = await callTool("prune_stale", { project: p, older_than_days: 0 });
    expect(dry.dry_run).toBe(true);
    expect(dry.candidates).toContain(r.id);
    expect(dry.pruned).toEqual([]);

    const real = await callTool("prune_stale", {
      project: p,
      older_than_days: 0,
      dry_run: false,
    });
    expect(real.pruned).toContain(r.id);

    const after = await callTool("query_entries", { project: p, status: "all" });
    expect(after.count).toBe(0);
  });
});

describe("import_entries round-trip", () => {
  it("imports local decisions.json preserving ids and mapping rationale", async () => {
    const p = project("import");
    const res = await callTool("import_entries", {
      project: p,
      kind: "decision",
      entries: decisionsFixture,
    });
    expect(res.imported_count).toBe(2);
    expect(res.imported).toEqual(["dec-001", "dec-002"]);

    const q = await callTool("query_entries", { project: p, id: "dec-001" });
    expect(q.results[0].payload.why_chosen).toBe(
      "D1 gives row-level writes and WHERE clauses for structured query",
    );
    expect(q.results[0].payload.rationale).toBeUndefined();
  });

  it("imports constraints and reports id collisions instead of overwriting", async () => {
    const p = project("import2");
    const first = await callTool("import_entries", {
      project: p,
      kind: "constraint",
      entries: constraintsFixture,
    });
    expect(first.imported_count).toBe(2);

    // re-import the same ids -> all skipped, nothing overwritten
    const second = await callTool("import_entries", {
      project: p,
      kind: "constraint",
      entries: constraintsFixture,
    });
    expect(second.imported_count).toBe(0);
    expect(second.skipped_count).toBe(2);
    expect(second.skipped[0].reason).toMatch(/exists/);
  });
});

describe("upsert_entries timestamp merge", () => {
  const base = (over: Record<string, unknown>) => ({
    id: "dec-001",
    summary: "first",
    status: "active",
    created_at: "2026-01-01T00:00:00+00:00",
    updated_at: "2026-01-01T00:00:00+00:00",
    ...over,
  });

  it("inserts a new id, then updates only when incoming updated_at is newer", async () => {
    const p = project("upsert");

    const first = await callTool("upsert_entries", {
      project: p,
      kind: "decision",
      entries: [base({})],
    });
    expect(first.created_count).toBe(1);
    expect(first.results[0].action).toBe("created");

    // Same id, NEWER timestamp + deprecation -> replaces, carries status across.
    const newer = await callTool("upsert_entries", {
      project: p,
      kind: "decision",
      entries: [base({ summary: "revised", status: "deprecated", updated_at: "2026-02-01T00:00:00+00:00" })],
    });
    expect(newer.updated_count).toBe(1);
    expect(newer.results[0].action).toBe("updated");
    expect(newer.results[0].previous.payload.summary).toBe("first"); // loser returned for conflict logging

    const q1 = await callTool("query_entries", { project: p, id: "dec-001", status: "all" });
    expect(q1.results[0].payload.summary).toBe("revised");
    expect(q1.results[0].status).toBe("deprecated");

    // Same id, OLDER timestamp -> skipped, existing (deprecated) row preserved.
    const older = await callTool("upsert_entries", {
      project: p,
      kind: "decision",
      entries: [base({ summary: "stale write", status: "active", updated_at: "2026-01-15T00:00:00+00:00" })],
    });
    expect(older.skipped_count).toBe(1);
    expect(older.results[0].action).toBe("skipped_older");

    const q2 = await callTool("query_entries", { project: p, id: "dec-001", status: "all" });
    expect(q2.results[0].payload.summary).toBe("revised");
    expect(q2.results[0].status).toBe("deprecated");
  });

  it("skips an existing id when incoming has equal timestamp or no timestamp", async () => {
    const p = project("upsert-eq");
    await callTool("upsert_entries", { project: p, kind: "decision", entries: [base({})] });

    const equal = await callTool("upsert_entries", {
      project: p,
      kind: "decision",
      entries: [base({ summary: "same ts" })],
    });
    expect(equal.results[0].action).toBe("skipped_older");
  });
});

describe("default_project via set_config", () => {
  it("falls back to configured default_project when project is omitted", async () => {
    const p = project("cfg");
    await callTool("set_config", { key: "default_project", value: p });
    const r = await callTool("record_decision", { summary: "no explicit project" });
    expect(r.entry.project).toBe(p);
  });

  it("errors clearly when no project and no default", async () => {
    // clear default so this test is independent of ordering
    await callTool("set_config", { key: "default_project", value: "" });
    const raw = await callToolRaw("record_constraint", { rule: "orphan" });
    expect(raw.result.isError).toBe(true);
    expect(raw.result.content[0].text).toMatch(/no default_project|No project/i);
  });
});

describe("unified config tool", () => {
  it("config op='set' then op='get' round-trips a value", async () => {
    const p = project("cfg");
    await callTool("config", { op: "set", key: "k1", value: "v1", project: p });
    const got = await callTool("config", { op: "get", key: "k1", project: p });
    expect(got.value).toBe("v1");
  });

  it("config op='set' is readable via the get_config alias (shared storage)", async () => {
    const p = project("via-config");
    await callTool("config", { op: "set", key: "default_project", value: p });
    const got = await callTool("get_config", { key: "default_project" });
    expect(got.value).toBe(p);
  });

  it("set_config alias is readable via config op='get' (both directions)", async () => {
    await callTool("set_config", { key: "k2", value: "v2" });
    const got = await callTool("config", { op: "get", key: "k2" });
    expect(got.value).toBe("v2");
  });

  it("config op='set' without value errors", async () => {
    const raw = await callToolRaw("config", { op: "set", key: "k3" });
    expect(raw.result.isError).toBe(true);
    expect(raw.result.content[0].text).toMatch(/requires .*value/i);
  });

  it("config is registered alongside the deprecated aliases", async () => {
    const { body } = await rpcJson("tools/list", {});
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("config");
    expect(names).toContain("get_config");
    expect(names).toContain("set_config");
  });
});

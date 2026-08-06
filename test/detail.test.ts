// The detail/project/search pages exist to close one gap: the phone showed a
// label per entry and none of the rationale, which is the only part worth
// carrying around. These tests are mostly "does the reasoning actually reach
// the page", plus the escaping and SQL edges that come with taking user input.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";
import { COOKIE_NAME } from "../src/install";

const VIEW = "view-token-for-tests";
const BASE = "https://example.com";
const cookie = { headers: { cookie: `${COOKIE_NAME}=${VIEW}` } };

async function get(path: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${BASE}${path}`, cookie),
    { ...env, VIEW_TOKEN: VIEW, AUTH_TOKEN: "auth" } as Env,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
const body = async (path: string) => (await get(path)).text();

const DECISION = {
  id: "dec-900-test",
  kind: "decision",
  project: "proj-alpha",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  superseded_by: null,
  payload: JSON.stringify({
    summary: "Use D1 rather than KV for the store",
    problem: "Two writers were clobbering each other with whole-file JSON writes",
    why_chosen: "Row-level writes and WHERE queries; the desktop and mobile clients stop racing",
    what_we_tried: "KV with a read-modify-write loop, which lost writes under concurrency",
    tradeoffs: "SQL migrations to maintain, and D1 has its own size ceilings",
    alternatives: [{ option: "Durable Objects", reason_rejected: "Not on the free plan" }],
    constraints_created: ["Schema is ensured lazily, never on the handshake"],
    retrieval_hints: ["why not KV", "lost writes"],
    related_to: ["con-900-test"],
    tags: ["storage", "d1"],
    origin: "user",
  }),
};

const OLD = {
  ...DECISION,
  id: "dec-899-old",
  status: "superseded",
  superseded_by: "dec-900-test",
  payload: JSON.stringify({ summary: "Use KV for the store", problem: "Needed somewhere to put it" }),
};

const CONSTRAINT = {
  id: "con-900-test",
  kind: "constraint",
  project: "proj-alpha",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-03T00:00:00Z",
  superseded_by: null,
  payload: JSON.stringify({
    rule: "Never run migrations on the MCP handshake",
    reason: "A D1 round-trip makes a cold handshake slow enough for clients to drop",
    scope: "src/index.ts",
    hardness: "absolute",
    enforced_by: "test/cold-start.test.ts",
    tags: ["mcp", "d1"],
  }),
};

const NASTY = {
  id: "dec-901-xss",
  kind: "decision",
  project: "proj<script>alpha",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-04T00:00:00Z",
  superseded_by: null,
  payload: JSON.stringify({
    summary: "<img src=x onerror=alert(1)>",
    problem: "100% of the time a_b matched everything",
  }),
};

beforeAll(async () => {
  const { runMigrations } = await import("../src/db");
  await runMigrations(env.DB as D1Database);
  for (const e of [DECISION, OLD, CONSTRAINT, NASTY]) {
    await (env.DB as D1Database)
      .prepare(
        `INSERT OR REPLACE INTO entries
         (id, kind, project, status, created_at, updated_at, superseded_by, payload)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(e.id, e.kind, e.project, e.status, e.created_at, e.updated_at, e.superseded_by, e.payload)
      .run();
  }
});

describe("entry detail carries the rationale, not just the label", () => {
  it("renders every narrative field", async () => {
    const html = await body(`/view?e=${DECISION.id}`);
    // These four are the whole reason the store exists, and none of them
    // reached the phone before.
    expect(html).toContain("Two writers were clobbering each other");
    expect(html).toContain("Row-level writes and WHERE queries");
    expect(html).toContain("KV with a read-modify-write loop");
    expect(html).toContain("SQL migrations to maintain");
  });

  it("renders alternatives with why each was rejected", async () => {
    const html = await body(`/view?e=${DECISION.id}`);
    expect(html).toContain("Durable Objects");
    expect(html).toContain("Not on the free plan");
  });

  it("renders list fields and links related entries and tags", async () => {
    const html = await body(`/view?e=${DECISION.id}`);
    expect(html).toContain("Schema is ensured lazily");
    expect(html).toContain(`/view?e=con-900-test`);
    expect(html).toContain(`/view?q=storage`);
  });

  it("renders constraint metadata", async () => {
    const html = await body(`/view?e=${CONSTRAINT.id}`);
    expect(html).toContain("src/index.ts");
    expect(html).toContain("absolute");
    expect(html).toContain("test/cold-start.test.ts");
    expect(html).toContain("A D1 round-trip makes a cold handshake slow");
  });

  it("404-page rather than a crash for an unknown id", async () => {
    const res = await get("/view?e=nope-does-not-exist");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No entry with that id");
  });
});

describe("the supersession trail", () => {
  it("shows a superseded entry pointing forward to what replaced it", async () => {
    const html = await body(`/view?e=${OLD.id}`);
    expect(html).toContain("superseded by dec-900-test");
    expect(html).toContain("read this instead");
    expect(html).toContain("Use D1 rather than KV");
  });

  it("shows the current entry pointing back at what it replaced", async () => {
    const html = await body(`/view?e=${DECISION.id}`);
    expect(html).toContain("replaces dec-899-old");
    expect(html).toContain("Use KV for the store");
  });

  it("reaches a superseded entry by direct link even though it is not active", async () => {
    // Filtering by status here would dead-end the trail exactly where it is
    // most interesting -- you got to this id by following a link.
    const res = await get(`/view?e=${OLD.id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Use KV for the store");
  });
});

describe("project drill-down", () => {
  it("groups a project's entries by kind", async () => {
    const html = await body(`/view?p=proj-alpha`);
    expect(html).toContain("decisions");
    expect(html).toContain("constraints");
    expect(html).toContain("Use D1 rather than KV");
    expect(html).toContain("Never run migrations on the MCP handshake");
  });

  it("hides superseded entries until asked", async () => {
    expect(await body(`/view?p=proj-alpha`)).not.toContain("Use KV for the store");
    expect(await body(`/view?p=proj-alpha&all=1`)).toContain("Use KV for the store");
  });
});

describe("search", () => {
  it("finds an entry by text that only appears in why_chosen", async () => {
    // The point of searching the payload rather than the summary: the answer is
    // usually in the reasoning, which no title contains.
    const html = await body(`/view?q=${encodeURIComponent("row-level writes")}`);
    expect(html).toContain("Use D1 rather than KV");
  });

  it("finds by tag and by id", async () => {
    expect(await body(`/view?q=storage`)).toContain("Use D1 rather than KV");
    expect(await body(`/view?q=con-900-test`)).toContain("Never run migrations");
  });

  it("treats LIKE wildcards as literal characters", async () => {
    // Unescaped, "%" is the match-anything wildcard: the search would return
    // the ENTIRE store while looking like it had found something, which is the
    // worst possible failure for a search box. Escaped, it matches only the one
    // entry whose text literally contains a percent sign.
    const pct = await body(`/view?q=${encodeURIComponent("%")}`);
    expect(pct).toContain("100%"); // the entry that really does contain "%"
    expect(pct).not.toContain("Use D1 rather than KV"); // everything else must NOT match

    // Same for "_", LIKE's single-character wildcard.
    const underscore = await body(`/view?q=${encodeURIComponent("a_b")}`);
    expect(underscore).toContain("100%");
    expect(underscore).not.toContain("Use D1 rather than KV");
  });

  it("prompts rather than dumping everything on an empty term", async () => {
    expect(await body(`/view?q=`)).toContain("Type something to search");
  });

  it("says so when nothing matched", async () => {
    expect(await body(`/view?q=zzzznotpresentzzzz`)).toContain("Nothing matched");
  });
});

describe("escaping", () => {
  it("escapes HTML in summaries, so a recorded string cannot inject markup", async () => {
    const html = await body(`/view?e=${NASTY.id}`);
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img src=x onerror");
  });

  it("escapes HTML in project names on the drill-down", async () => {
    const html = await body(`/view?p=${encodeURIComponent("proj<script>alpha")}`);
    expect(html).not.toContain("<script>alpha");
    expect(html).toContain("&lt;script&gt;alpha");
  });

  it("escapes the search term it echoes back", async () => {
    const html = await body(`/view?q=${encodeURIComponent("<script>x</script>")}`);
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("the shell survives on every page", () => {
  it("keeps the manifest link, so a deep page is still an installed app", async () => {
    for (const p of [`/view`, `/view?e=${DECISION.id}`, `/view?p=proj-alpha`, `/view?q=d1`]) {
      const html = await body(p);
      expect(html, p).toContain('rel="manifest"');
      expect(html, p).toContain('crossorigin="use-credentials"');
    }
  });

  it("allows the search form in CSP and nothing more", async () => {
    const csp = (await get("/view?q=x")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Scripts are allowed now (app.js registers the service worker) but only
    // from 'self'. No inline execution, which is the property that protects
    // against anything that got through the escaper.
    expect(csp.match(/script-src[^;]*/)?.[0]).not.toContain("unsafe-inline");
  });

  it("still refuses every page without the cookie", async () => {
    for (const p of [`/view?e=${DECISION.id}`, `/view?p=proj-alpha`, `/view?q=d1`]) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`${BASE}${p}`),
        { ...env, VIEW_TOKEN: VIEW } as Env,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status, p).toBe(404);
    }
  });
});

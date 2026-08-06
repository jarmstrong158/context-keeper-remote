// health.ts had no tests, which is the wrong module to leave uncovered.
//
// It decides what the Health tab calls a problem, and one of its rules --
// mojibake detection -- has a documented history in this project of being
// wrong: an enumerated marker list came up short four separate times, which is
// why the rule here is structural instead. A detector that MISSES corruption
// leaves it unrepaired; a detector that INVENTS it sends someone to hand-edit a
// rationale that was fine. Both directions are tested.

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";
import { looksLikeMojibake, healthReport } from "../src/health";
import { COOKIE_NAME } from "../src/install";

const VIEW = "view-token-for-tests";
const P = "health-fixture";

/** What cp1252-misdecoded UTF-8 actually looks like, produced rather than typed. */
function corrupt(s: string): string {
  const utf8 = new TextEncoder().encode(s);
  // cp1252 and latin-1 agree on the bytes that matter here.
  return Array.from(utf8, (b) => String.fromCharCode(b)).join("");
}

describe("looksLikeMojibake finds real corruption", () => {
  it("flags text that was UTF-8 and got read as cp1252", () => {
    for (const clean of ["café", "naïve", "Zoë", "résumé"]) {
      const broken = corrupt(clean);
      expect(broken, clean).not.toBe(clean);
      expect(looksLikeMojibake(broken), `${clean} -> ${broken}`).toBe(true);
    }
  });

  it("flags corrupted punctuation, which is the common case in prose", () => {
    // Em-dashes, curly quotes and arrows are what actually appear in rationale
    // text, and they corrupt to the â-lead sequences.
    for (const clean of ["a — b", "an “example”", "x → y", "done ✓"]) {
      expect(looksLikeMojibake(corrupt(clean)), clean).toBe(true);
    }
  });
});

describe("looksLikeMojibake does NOT invent corruption", () => {
  it("leaves legitimate non-ASCII alone", () => {
    // These are correctly-encoded strings. Flagging them would send someone to
    // "repair" text that is already right -- and the repair is lossy.
    for (const ok of [
      "café", "naïve", "Zoë", "résumé",
      "a — b", "an “example”", "x → y", "done ✓",
      "emoji \u{1F600} in a summary", "µs latency", "50° angle",
    ]) {
      expect(looksLikeMojibake(ok), ok).toBe(false);
    }
  });

  it("leaves plain ASCII alone", () => {
    for (const ok of ["nothing special", "", "a", "-- em dash written as ascii"]) {
      expect(looksLikeMojibake(ok), ok).toBe(false);
    }
  });

  it("does not flag a lead character followed by ASCII", () => {
    // "Â" alone is legitimate; it is only a signal when the NEXT character is
    // also non-ASCII, which is what makes this a structural rule rather than a
    // list of characters to fear.
    expect(looksLikeMojibake("Â alone")).toBe(false);
    expect(looksLikeMojibake("â alone")).toBe(false);
  });

  it("survives a lead character at the very end without reading past it", () => {
    expect(looksLikeMojibake("trailing Ã")).toBe(false);
  });
});

describe("the report counts the right rows", () => {
  const rows = [
    // active, healthy: long rationale, tagged, recent, scoped constraint
    ["h-1", "constraint", "active", null, {
      rule: "a rule", scope: "src/index.ts", tags: ["x"],
      reason: "y".repeat(200),
    }],
    // active, thin rationale
    ["h-2", "decision", "active", null, { summary: "s", why_chosen: "short", tags: ["x"] }],
    // active, untagged
    ["h-3", "decision", "active", null, { summary: "s", why_chosen: "z".repeat(200) }],
    // active constraint scoped global -> counts as a constraint, NOT as scoped
    ["h-4", "constraint", "active", null, {
      rule: "r", scope: "global", tags: ["x"], reason: "w".repeat(200),
    }],
    // superseded: must NOT contribute quality flags, but MUST count as an entry
    ["h-5", "decision", "superseded", "h-1", { summary: "old", why_chosen: "t" }],
  ] as const;

  beforeAll(async () => {
    const { runMigrations } = await import("../src/db");
    await runMigrations(env.DB as D1Database);
    const now = new Date().toISOString();
    for (const [id, kind, status, sup, payload] of rows) {
      await (env.DB as D1Database)
        .prepare(`INSERT OR REPLACE INTO entries
          (id, kind, project, status, created_at, updated_at, superseded_by, payload)
          VALUES (?,?,?,?,?,?,?,?)`)
        .bind(id, kind, P, status, now, now, sup, JSON.stringify(payload))
        .run();
    }
  });

  it("counts quality flags on ACTIVE entries only", async () => {
    const r = await healthReport(env.DB as D1Database);
    const p = r.projects.find((x) => x.project === P)!;
    expect(p).toBeDefined();
    // h-5 is superseded: its thin rationale and missing tags are already out of
    // retrieval, so counting them would make cleaning up look like regression.
    expect(p.total).toBe(4);
    expect(p.thin).toBe(1);     // h-2 only
    expect(p.untagged).toBe(1); // h-3 only
  });

  it("counts entries and supersession links across the WHOLE history", async () => {
    const r = await healthReport(env.DB as D1Database);
    const p = r.projects.find((x) => x.project === P)!;
    // A project whose supersession links all point at deprecated entries has
    // done exactly the right thing; filtering them would show it as having done
    // nothing.
    expect(p.entries).toBe(5);
    expect(p.supersedes).toBe(1);
  });

  it("counts a global-scoped constraint as a constraint but not as scoped", async () => {
    const r = await healthReport(env.DB as D1Database);
    const p = r.projects.find((x) => x.project === P)!;
    expect(p.constraints).toBe(2); // h-1 and h-4
    expect(p.scoped).toBe(1);      // h-1 only -- global is not enforceable
  });

  it("reports nothing stale for entries updated just now", async () => {
    const r = await healthReport(env.DB as D1Database);
    expect(r.projects.find((x) => x.project === P)!.stale).toBe(0);
  });
});

describe("the Health tab renders what the report found", () => {
  it("shows the flags and the project", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://example.com/view?t=health", {
        headers: { cookie: `${COOKIE_NAME}=${VIEW}` },
      }),
      { ...env, VIEW_TOKEN: VIEW } as Env,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("thin rationale");
    expect(html).toContain("untagged");
    expect(html).toContain("mojibake");
    expect(html).toContain(P);
  });
});

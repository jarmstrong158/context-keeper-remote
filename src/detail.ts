// Entry detail, project drill-down, and search: the parts that make the phone
// view the tool rather than a summary of it.
//
// WHAT WAS MISSING
//
// The home feed showed a label per entry -- a truncated `summary` or `rule` --
// and nothing else. But a label is the least valuable field context-keeper
// holds. The reason the store exists is `problem`, `why_chosen`,
// `what_we_tried`, `tradeoffs` and `alternatives`: not what was decided, but
// why, what was tried first, and what it cost. Those never reached the phone at
// all, so "why did we do it this way?" -- the question you actually have when
// you are away from your desk -- was the one question the phone could not
// answer.
//
// There was also no way in. No project drill-down, no search, no access to
// deprecated or superseded entries, and a hard 25-entry feed. Everything past
// the most recent 25 was simply unreachable.
//
// HOW
//
// Query parameters on the existing /view path rather than new routes, so every
// page inherits the same cookie check with no second auth surface to keep in
// step. Server-rendered links only -- no script, no fetch, no client-side
// state, which is what keeps the CSP at `default-src 'none'` and means the
// whole thing works on a bad connection and with JS disabled.

import { type Entry, hydrate, type EntryRow } from "./db";

export const PAGE_SIZE = 60;

/** Fields worth rendering, in the order they are worth reading. */
const NARRATIVE_FIELDS: Array<[string, string]> = [
  ["problem", "Problem"],
  ["reason", "Why it exists"],
  ["purpose", "Purpose"],
  ["why_chosen", "Why chosen"],
  ["what_we_tried", "What we tried first"],
  ["triggering_incident", "What triggered it"],
  ["tradeoffs", "Tradeoffs"],
  ["when_to_invoke", "When to invoke"],
];

const META_FIELDS: Array<[string, string]> = [
  ["scope", "Scope"],
  ["hardness", "Hardness"],
  ["enforced_by", "Enforced by"],
  ["origin", "Origin"],
];

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Preserve paragraph breaks without allowing any markup through. */
function para(s: unknown): string {
  return esc(s)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function title(e: Entry): string {
  const p = e.payload;
  return String(p.summary || p.rule || p.name || "(untitled)");
}

/**
 * Fetch one entry plus the entries immediately either side of it in the
 * supersession chain.
 *
 * Deliberately reads regardless of status: the whole point of asking for a
 * specific id is that you followed a link to it, and half the time that link
 * came from a superseded entry pointing forward. Filtering by status here would
 * make the trail dead-end exactly where it is most interesting.
 */
export async function loadEntry(
  db: D1Database,
  id: string,
): Promise<{ entry: Entry; predecessor: Entry | null; successor: Entry | null } | null> {
  const row = await db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(id).first<EntryRow>();
  if (!row) return null;
  const entry = hydrate(row);

  // Successor: what replaced this. Predecessor: what this replaced -- found by
  // looking for whoever points AT us, since supersession is recorded forwards.
  const [succRow, predRow] = await Promise.all([
    entry.superseded_by
      ? db.prepare(`SELECT * FROM entries WHERE id = ?`).bind(entry.superseded_by).first<EntryRow>()
      : Promise.resolve(null),
    db.prepare(`SELECT * FROM entries WHERE superseded_by = ? LIMIT 1`).bind(id).first<EntryRow>(),
  ]);

  return {
    entry,
    successor: succRow ? hydrate(succRow) : null,
    predecessor: predRow ? hydrate(predRow) : null,
  };
}

export async function loadProject(
  db: D1Database,
  project: string,
  includeAll: boolean,
): Promise<Entry[]> {
  const sql = includeAll
    ? `SELECT * FROM entries WHERE project = ? ORDER BY
         CASE status WHEN 'active' THEN 0 ELSE 1 END, kind, updated_at DESC LIMIT ?`
    : `SELECT * FROM entries WHERE project = ? AND status = 'active'
       ORDER BY kind, updated_at DESC LIMIT ?`;
  const res = await db.prepare(sql).bind(project, PAGE_SIZE).all<EntryRow>();
  return (res.results ?? []).map(hydrate);
}

/**
 * Search.
 *
 * LIKE over the raw payload JSON rather than a per-field query. It is not
 * clever, but it searches every structured field at once -- including
 * why_chosen and what_we_tried, which is where the answer usually is -- and it
 * needs no FTS table, no index to keep in sync, and no migration. At this
 * store's size the scan is far cheaper than the round trip that delivered the
 * request.
 *
 * The term is bound as a parameter, never interpolated. It also escapes LIKE's
 * own wildcards, so searching for "100%" or "a_b" means those literal
 * characters instead of silently matching everything.
 */
export async function search(db: D1Database, term: string, includeAll: boolean): Promise<Entry[]> {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${escaped}%`;
  const statusClause = includeAll ? "" : "AND status = 'active'";
  const res = await db
    .prepare(
      `SELECT * FROM entries
       WHERE (payload LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')
       ${statusClause}
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`,
    )
    .bind(like, like, like, PAGE_SIZE)
    .all<EntryRow>();
  return (res.results ?? []).map(hydrate);
}

// --- rendering -------------------------------------------------------------

const KIND_CLASS: Record<string, string> = { decision: "d", constraint: "c", pipeline: "p" };

/** One row in any list of entries. The whole row is the tap target. */
export function entryRow(e: Entry, showProject = true): string {
  const dead = e.status !== "active";
  return `<li class="e${dead ? " dead" : ""}"><a href="/view?e=${encodeURIComponent(e.id)}">
    <div class="m"><span class="k ${KIND_CLASS[e.kind] ?? ""}">${esc(e.kind)}</span>
      ${showProject ? `<span class="pj">${esc(e.project)}</span>` : ""}
      ${dead ? `<span class="dd">${esc(e.status)}</span>` : ""}
      <span class="ts">${esc(ago(e.updated_at))}</span></div>
    <div class="t">${esc(clamp(title(e), 180))}</div></a></li>`;
}

function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function ago(iso: string): string {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return mins + "m";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h";
  const days = Math.round(hrs / 24);
  return days < 30 ? days + "d" : Math.round(days / 30) + "mo";
}

/** The full entry: every structured field context-keeper holds. */
export function entryDetail(
  entry: Entry,
  predecessor: Entry | null,
  successor: Entry | null,
): string {
  const p = entry.payload;
  const dead = entry.status !== "active";

  const narrative = NARRATIVE_FIELDS.filter(([k]) => p[k])
    .map(([k, lbl]) => `<section><h3>${lbl}</h3>${para(p[k])}</section>`)
    .join("");

  const steps = Array.isArray(p.steps) && p.steps.length
    ? `<section><h3>Steps</h3><ol class="steps">${(p.steps as any[])
        .map((s) => `<li>${esc(s?.action ?? s)}${s?.output ? `<em> &rarr; ${esc(s.output)}</em>` : ""}</li>`)
        .join("")}</ol></section>`
    : "";

  const alts = Array.isArray(p.alternatives) && p.alternatives.length
    ? `<section><h3>Alternatives considered</h3><ul class="alts">${(p.alternatives as any[])
        .map(
          (a) => `<li><b>${esc(a?.option ?? a)}</b>${
            a?.reason_rejected ? `<span>${esc(a.reason_rejected)}</span>` : ""
          }</li>`,
        )
        .join("")}</ul></section>`
    : "";

  const listField = (key: string, lbl: string) =>
    Array.isArray(p[key]) && (p[key] as unknown[]).length
      ? `<section><h3>${lbl}</h3><ul class="bul">${(p[key] as unknown[])
          .map((v) => `<li>${esc(v)}</li>`)
          .join("")}</ul></section>`
      : "";

  const related = Array.isArray(p.related_to) && p.related_to.length
    ? `<section><h3>Related</h3><div class="chips">${(p.related_to as unknown[])
        .map((id) => `<a class="chip" href="/view?e=${encodeURIComponent(String(id))}">${esc(id)}</a>`)
        .join("")}</div></section>`
    : "";

  const tags = Array.isArray(p.tags) && p.tags.length
    ? `<div class="chips">${(p.tags as unknown[])
        .map((t) => `<a class="chip" href="/view?q=${encodeURIComponent(String(t))}">${esc(t)}</a>`)
        .join("")}</div>`
    : "";

  const meta = META_FIELDS.filter(([k]) => p[k])
    .map(([k, lbl]) => `<div class="kv"><span>${lbl}</span><b>${esc(p[k])}</b></div>`)
    .join("");

  // The supersession trail. This is the one thing a summary genuinely cannot
  // convey: that a rule USED to say something else, and why it stopped.
  const trail = [
    predecessor
      ? `<a class="trail" href="/view?e=${encodeURIComponent(predecessor.id)}">
           <span>replaces ${esc(predecessor.id)}</span>${esc(clamp(title(predecessor), 120))}</a>`
      : "",
    successor
      ? `<a class="trail now" href="/view?e=${encodeURIComponent(successor.id)}">
           <span>superseded by ${esc(successor.id)} &mdash; read this instead</span>${esc(
             clamp(title(successor), 120),
           )}</a>`
      : "",
  ].join("");

  return `
<div class="crumb"><a href="/view">memory</a> / <a href="/view?p=${encodeURIComponent(
    entry.project,
  )}">${esc(entry.project)}</a></div>
<article class="det${dead ? " dead" : ""}">
  <div class="m"><span class="k ${KIND_CLASS[entry.kind] ?? ""}">${esc(entry.kind)}</span>
    ${dead ? `<span class="dd">${esc(entry.status)}</span>` : ""}
    <span class="ts">${esc(ago(entry.updated_at))}</span></div>
  <h1 class="dt">${esc(title(entry))}</h1>
  ${trail}
  ${meta ? `<div class="metaGrid">${meta}</div>` : ""}
  ${narrative}
  ${steps}
  ${alts}
  ${listField("constraints_created", "Constraints this created")}
  ${listField("constraints", "Constraints")}
  ${listField("retrieval_hints", "Also findable as")}
  ${related}
  ${tags}
  <div class="idline">${esc(entry.id)} &middot; recorded ${esc(
    (entry.created_at || "").slice(0, 10),
  )}</div>
</article>`;
}

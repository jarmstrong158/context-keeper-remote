// Health: the quality tab the desktop dashboard has and the phone did not.
//
// The desktop dashboard ranks projects by flagged entries -- mojibake, thin
// rationale, untagged, stale -- because a store that is merely LARGE looks
// identical to a store that is rotting until you count. That distinction is
// exactly what you want on a phone: not to fix anything, but to know whether
// the thing you are about to trust is in good repair.
//
// Computed here rather than mirrored from the desktop tool: the desktop reads
// local .context directories, and this Worker's D1 is a separate copy. Reading
// the numbers off the data actually being served is the only way the tab can be
// true about what you are looking at.

import { hydrate, type Entry, type EntryRow } from "./db";
import { esc } from "./html";

// Older than this without an update is "stale" -- not wrong, but nobody has
// confirmed it in half a year. Deliberately generous: context-keeper's own
// guidance is that age matters less than whether the code moved, and flagging
// six-month-old entries as problems would bury the ones that matter.
const STALE_DAYS = 180;

// Below this, a rationale field is a label rather than an explanation. The
// schema enforces 40-60 char minimums; the realistic floor for something a
// future session can use is a couple of sentences.
const THIN_CHARS = 120;

// cp1252-misdecoded UTF-8. A structural rule rather than a list of known
// sequences: an enumerated list of markers came up short four separate times in
// this project's history, because the list can only ever cover the corruptions
// somebody already saw. Any of these lead bytes followed by another non-ASCII
// character is the signature, whatever the specific pair turns out to be.
const MOJIBAKE_LEADS = "ÃÂâ";

export function looksLikeMojibake(text: string): boolean {
  for (let i = 0; i < text.length - 1; i++) {
    if (MOJIBAKE_LEADS.includes(text[i]!) && text.charCodeAt(i + 1) > 127) return true;
  }
  return false;
}

/** The fields that carry the reasoning, by kind. */
const RATIONALE_KEYS = ["why_chosen", "reason", "purpose", "problem"];

export interface ProjectHealth {
  project: string;
  total: number;
  mojibake: number;
  thin: number;
  untagged: number;
  stale: number;
  flagged: number;
  // Columns the desktop dashboard's Projects table shows. Carried on the same
  // record because both tabs are answered by one scan -- computing them
  // separately would mean two full passes over the store to render two views of
  // the same rows.
  entries: number;
  constraints: number;
  scoped: number;
  supersedes: number;
}

export interface HealthReport {
  projects: ProjectHealth[];
  totals: { total: number; mojibake: number; thin: number; untagged: number; stale: number };
}

interface Flags { mojibake: number; thin: number; untagged: number; stale: number }

function flagsFor(e: Entry, now: number): Flags {
  const p = e.payload;

  // Every string in the payload, so corruption is caught wherever it landed --
  // not just in the summary that happens to be rendered.
  let mojibake = 0;
  for (const v of Object.values(p)) {
    if (typeof v === "string" && looksLikeMojibake(v)) { mojibake = 1; break; }
  }

  const rationale = RATIONALE_KEYS.map((k) => (typeof p[k] === "string" ? (p[k] as string) : ""))
    .sort((a, b) => b.length - a.length)[0] ?? "";
  const thin = rationale.length < THIN_CHARS ? 1 : 0;

  const untagged = Array.isArray(p.tags) && p.tags.length > 0 ? 0 : 1;

  const seen = Date.parse(e.updated_at || "");
  const stale = Number.isFinite(seen) && now - seen > STALE_DAYS * 86400_000 ? 1 : 0;

  return { mojibake, thin, untagged, stale };
}

export async function healthReport(db: D1Database): Promise<HealthReport> {
  // Every entry, not just active. `entries` and `supersedes` are about the
  // whole history -- a project whose supersession links all point at deprecated
  // entries has done exactly the right thing, and filtering them out would make
  // that look like it had done nothing.
  const res = await db.prepare(`SELECT * FROM entries`).all<EntryRow>();
  const entries = (res.results ?? []).map(hydrate);
  const now = Date.now();

  const byProject = new Map<string, ProjectHealth>();
  const totals = { total: 0, mojibake: 0, thin: 0, untagged: 0, stale: 0 };

  for (const e of entries) {
    const cur =
      byProject.get(e.project) ??
      { project: e.project, total: 0, mojibake: 0, thin: 0, untagged: 0, stale: 0,
        flagged: 0, entries: 0, constraints: 0, scoped: 0, supersedes: 0 };

    cur.entries++;
    if (e.superseded_by) cur.supersedes++;

    // Quality flags describe entries that are still in play. A deprecated entry
    // with a thin rationale is not work to do -- it is already out of
    // retrieval, and counting it would make cleaning up look like regression.
    if (e.status === "active") {
      const f = flagsFor(e, now);
      cur.total++;
      cur.mojibake += f.mojibake;
      cur.thin += f.thin;
      cur.untagged += f.untagged;
      cur.stale += f.stale;
      cur.flagged += f.mojibake + f.thin + f.untagged + f.stale;

      if (e.kind === "constraint") {
        cur.constraints++;
        // A constraint scoped to a real path is enforceable: it drives the
        // scope_guard hook, the rules projection, and the drift check. Scoped
        // "global" it is a session-start memo with nothing to check against, so
        // this column is the ratio that matters, not the raw constraint count.
        const scope = e.payload.scope;
        if (typeof scope === "string" && scope && scope !== "global") cur.scoped++;
      }

      totals.total++;
      totals.mojibake += f.mojibake;
      totals.thin += f.thin;
      totals.untagged += f.untagged;
      totals.stale += f.stale;
    }

    byProject.set(e.project, cur);
  }

  return {
    projects: [...byProject.values()].sort((a, b) => b.flagged - a.flagged),
    totals,
  };
}


function bar(n: number, d: number, cls: string, label: string, note: string): string {
  const pct = d ? Math.round((n / d) * 1000) / 10 : 0;
  return `<div class="hrow">
    <div class="hl">${label}</div>
    <div class="trk"><div class="fill ${cls}" style="width:${d ? (n / d) * 100 : 0}%"></div></div>
    <div class="hv"><b>${n}</b> <span>/ ${d} (${pct}%)</span></div>
    <div class="hn">${note}</div>
  </div>`;
}

export function healthHtml(r: HealthReport): string {
  const t = r.totals;
  if (!t.total) return `<div class="note">Nothing recorded yet, so nothing to report on.</div>`;

  const bars = [
    bar(t.mojibake, t.total, "bad", "mojibake",
      "Text written before UTF-8 was forced on the transport. Repairable exactly; do not hand-edit."),
    bar(t.thin, t.total, "warn", "thin rationale",
      `The reasoning field is under ${THIN_CHARS} characters &mdash; a label, not an explanation.`),
    bar(t.untagged, t.total, "warn", "untagged",
      "Will not surface in a tag query, so it is only findable by full-text luck."),
    bar(t.stale, t.total, "warn", "stale",
      `Not updated in ${STALE_DAYS} days. Age is weaker evidence than code drift, so treat as a prompt to check, not a defect.`),
  ].join("");

  const rows = r.projects
    .filter((p) => p.flagged > 0)
    .map(
      (p) => `<tr><td><a href="/view?p=${encodeURIComponent(p.project)}">${esc(p.project)}</a></td>
        <td class="num${p.mojibake ? " bad" : ""}">${p.mojibake || "&ndash;"}</td>
        <td class="num">${p.thin || "&ndash;"}</td>
        <td class="num">${p.untagged || "&ndash;"}</td>
        <td class="num">${p.stale || "&ndash;"}</td>
        <td class="num"><b>${p.flagged}</b></td></tr>`,
    )
    .join("");

  return `<h2>Across ${t.total} active entries</h2>
    <div class="health">${bars}</div>
    <h2>By project</h2>
    ${
      rows
        ? `<div class="tw"><table>
             <thead><tr><th>project</th><th class="num">moji</th><th class="num">thin</th>
               <th class="num">untag</th><th class="num">stale</th><th class="num">all</th></tr></thead>
             <tbody>${rows}</tbody></table></div>`
        : `<div class="note"><b>Nothing flagged.</b> Every active entry has tags, a real
           rationale, clean encoding, and has been touched recently.</div>`
    }
    <div class="note">A big store and a rotting store look identical until you count.
    This is that count, taken from the data this Worker is actually serving &mdash; not
    from the local <code>.context</code> directories the desktop tool reads.</div>`;
}

/**
 * The Projects table, matching the desktop dashboard's columns.
 *
 * `scoped` is the one worth reading twice: it counts constraints pointed at a
 * real file or directory rather than "global". A scoped constraint drives the
 * scope_guard hook, the .claude/rules projection and the drift check; a global
 * one is a session-start memo with nothing to check against. So the ratio of
 * scoped to constraints is how much of a project's rulebook is actually
 * enforceable, which the raw constraint count cannot tell you.
 *
 * `distilled` and `recalls` are deliberately absent: they live in cambium, not
 * here, and inventing a column this Worker cannot populate would be worse than
 * not showing it. The Knowledge tab says where they are.
 */
export function projectsHtml(r: HealthReport): string {
  if (!r.projects.length) return `<div class="note">Nothing recorded yet.</div>`;
  const byName = [...r.projects].sort((a, b) => b.entries - a.entries);
  const rows = byName
    .map(
      (p) => `<tr><td><a href="/view?p=${encodeURIComponent(p.project)}">${esc(p.project)}</a></td>
        <td class="num">${p.entries}</td>
        <td class="num">${p.total}</td>
        <td class="num">${p.constraints || "&ndash;"}</td>
        <td class="num">${p.scoped || "&ndash;"}</td>
        <td class="num">${p.supersedes || "&ndash;"}</td>
        <td class="num">${p.stale || "&ndash;"}</td>
        <td class="num${p.mojibake ? " bad" : ""}">${p.mojibake || "&ndash;"}</td></tr>`,
    )
    .join("");
  return `<h2>Every project's decision log</h2>
    <div class="tw"><table>
      <thead><tr><th>project</th><th class="num">all</th><th class="num">active</th>
        <th class="num">con</th><th class="num">scoped</th><th class="num">sup</th>
        <th class="num">stale</th><th class="num">moji</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="note"><b>scoped</b> counts constraints aimed at a real path rather
    than <code>global</code>. Only those drive the scope_guard hook, the rules
    projection and the drift check &mdash; a global constraint is a session-start
    memo with nothing to check against, so that ratio is how much of a project's
    rulebook is actually enforceable. <b>sup</b> is supersession links: entries
    that recorded what replaced them instead of being edited in place.</div>`;
}

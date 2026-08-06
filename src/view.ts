// A read-only, phone-shaped HTML view of the store.
//
// WHY A SECOND TOKEN
//
// The MCP connector URL embeds AUTH_TOKEN and that token is read/write over
// every project. A dashboard is a URL you open on a phone, so it lands in
// browser history, tab sync, and any screenshot -- and this project's own audit
// already found connector URLs in ~54 places across 13 local transcripts on one
// machine. Reusing AUTH_TOKEN here would put a full-write credential in the
// place most likely to leak it, and rotating it to recover would break every
// claude.ai connector at the same moment.
//
// So the view has its own secret, VIEW_TOKEN, on a GET-only route that issues
// nothing but SELECTs. A leaked glance-URL then discloses decision summaries
// rather than handing over write access to 34 projects. The two are never
// interchangeable: AUTH_TOKEN is rejected here and VIEW_TOKEN is rejected on
// /mcp, so neither can be quietly substituted for the other.
//
// Unset VIEW_TOKEN means the route 404s exactly like any other unknown path.
// The feature is off until you deliberately turn it on, and an operator who
// never sets it is not carrying a second credential they forgot about.
//
// SERVER-RENDERED ON PURPOSE
//
// No client-side fetch, so the token never reaches JavaScript, there is no CORS
// surface, and the page works with scripting disabled. It is one document with
// inline CSS -- on a phone, on mobile data, that is the difference between
// glanceable and not.

import { type Entry, hydrate, type EntryRow } from "./db";

// How long the page will wait on cambium-remote before rendering without it.
// A phone on mobile data must not hang because a SECOND service is slow: the
// decision logs are this Worker's own data and always render. The knowledge
// panel is an enrichment, and it degrades to a stated absence.
const CAMBIUM_TIMEOUT_MS = 2500;

interface KnowledgeSummary {
  teamActive: number;
  orgActive: number;
  teamRepos: number;
  error?: string;
}

/** Ask cambium-remote for its status counts. Never throws.
 *
 * cambium-remote is a separate Worker with its own path-token credential, so
 * this needs CAMBIUM_STATUS_URL (the full /mcp/<token> URL) set as a secret
 * here. Unset means the panel simply says where that data lives -- the feature
 * is opt-in and its absence is stated rather than implied.
 *
 * Read-only in the strongest sense: `status` on that server performs no writes,
 * and its own recall deliberately does not increment recall counters. Glancing
 * at knowledge from a phone therefore cannot perturb the promotion signals the
 * desktop side reasons about.
 */
async function fetchKnowledge(url: string | undefined): Promise<KnowledgeSummary | null> {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CAMBIUM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // con-007 in context-keeper: Cloudflare's bot rules 403 a default
        // client UA, and the failure presents as a silent empty panel.
        "user-agent": "context-keeper-view/1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "status", arguments: {} },
      }),
    });
    if (!res.ok) return { teamActive: 0, orgActive: 0, teamRepos: 0, error: "http " + res.status };
    const body: any = await res.json();
    const c = body?.result?.structuredContent?.counts;
    if (!c) return { teamActive: 0, orgActive: 0, teamRepos: 0, error: "unexpected response" };
    return {
      teamActive: Number(c.team_active || 0),
      orgActive: Number(c.org_active || 0),
      teamRepos: Number(c.team_repos || 0),
    };
  } catch (e) {
    return {
      teamActive: 0, orgActive: 0, teamRepos: 0,
      error: (e as Error)?.name === "AbortError" ? "timed out" : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

const MAX_FEED = 25;
const SUMMARY_CHARS = 180;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function label(e: Entry): string {
  const p = e.payload;
  const t = String(p.summary || p.rule || p.name || "(untitled)");
  return t.length > SUMMARY_CHARS ? t.slice(0, SUMMARY_CHARS - 1) + "…" : t;
}

function ago(iso: string): string {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return mins + "m";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h";
  const days = Math.round(hrs / 24);
  return days < 30 ? days + "d" : Math.round(days / 30) + "mo";
}

const KIND_CLASS: Record<string, string> = {
  decision: "d",
  constraint: "c",
  pipeline: "p",
};

interface Rollup {
  project: string;
  decisions: number;
  constraints: number;
  pipelines: number;
  active: number;
  updated_at: string | null;
}

export async function renderView(
  db: D1Database,
  cambiumUrl?: string,
): Promise<string> {
  // One rollup query and one feed query. Two round-trips, not two per project:
  // this is rendered on a phone, on mobile data, and a fan-out per project
  // would make the page slower than it is useful.
  // Kicked off before the D1 work so the cross-Worker round trip overlaps it
  // rather than adding to it.
  const knowledgeP = fetchKnowledge(cambiumUrl);

  const rollup = await db
    .prepare(
      `SELECT project,
         SUM(CASE WHEN kind='decision'   AND status='active' THEN 1 ELSE 0 END) AS decisions,
         SUM(CASE WHEN kind='constraint' AND status='active' THEN 1 ELSE 0 END) AS constraints,
         SUM(CASE WHEN kind='pipeline'   AND status='active' THEN 1 ELSE 0 END) AS pipelines,
         SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
         MAX(updated_at) AS updated_at
       FROM entries GROUP BY project
       ORDER BY MAX(updated_at) DESC`,
    )
    .all<Rollup>();

  const feed = await db
    .prepare(
      `SELECT * FROM entries WHERE status = 'active'
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(MAX_FEED)
    .all<EntryRow>();

  const projects = (rollup.results ?? []).filter((p) => p.active > 0);
  const entries = (feed.results ?? []).map(hydrate);

  const knowledge = await knowledgeP;

  const totals = projects.reduce(
    (a, p) => ({
      dec: a.dec + Number(p.decisions || 0),
      con: a.con + Number(p.constraints || 0),
      pipe: a.pipe + Number(p.pipelines || 0),
    }),
    { dec: 0, con: 0, pipe: 0 },
  );
  const freshest = projects[0]?.updated_at ?? "";

  const feedHtml = entries
    .map(
      (e) => `<li class="e">
      <div class="m"><span class="k ${KIND_CLASS[e.kind] ?? ""}">${esc(e.kind)}</span>
        <span class="pj">${esc(e.project)}</span>
        <span class="ts">${esc(ago(e.updated_at))}</span></div>
      <div class="t">${esc(label(e))}</div></li>`,
    )
    .join("");

  const projHtml = projects
    .map(
      (p) => `<li class="p">
      <span class="pn">${esc(p.project)}</span>
      <span class="pc">${p.decisions}<i>d</i> ${p.constraints}<i>c</i>${
        Number(p.pipelines) ? ` ${p.pipelines}<i>p</i>` : ""
      }</span>
      <span class="ts">${esc(ago(p.updated_at ?? ""))}</span></li>`,
    )
    .join("");

  const knowledgeHtml = !knowledge
    ? `<h2>Knowledge</h2><div class="note"><b>Not connected.</b> cambium's distilled
       knowledge lives in cambium-remote. Set <code>CAMBIUM_STATUS_URL</code> here to
       show its team and org counts. Local scope is desktop-only by design and never
       appears anywhere but the machine that learned it.</div>`
    : knowledge.error
      ? `<h2>Knowledge</h2><div class="note"><b>cambium-remote ${esc(knowledge.error)}.</b>
         The decision logs above are this Worker's own data and are unaffected.</div>`
      : `<h2>Knowledge</h2>
         <ul>
           <li class="p"><span class="pn">team</span>
             <span class="pc">${knowledge.teamActive}<i> items</i></span>
             <span class="ts">${knowledge.teamRepos} repos</span></li>
           <li class="p"><span class="pn">org</span>
             <span class="pc">${knowledge.orgActive}<i> items</i></span>
             <span class="ts"></span></li>
         </ul>
         <div class="note"><b>Local scope is not shown.</b> It is desktop-only by
         design, so it never leaves the machine that learned it &mdash; and it is the
         staging area, not the part that gets read. Promoted knowledge is what
         recall actually returns.</div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="memory">
<meta name="theme-color" content="#0b0e13">
<title>memory</title>
<!-- Installability. crossorigin="use-credentials" is load-bearing: a manifest is
     fetched WITHOUT cookies by default, so behind a credential it would 404 and
     the install prompt would silently never appear. The icon is an ordinary
     same-origin image request and carries the cookie on its own. -->
<link rel="manifest" href="/view/manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="/view/icon.png">
<link rel="icon" type="image/png" href="/view/icon.png">
<style>
:root{--bg:#0b0e13;--pan:#12161d;--line:#222934;--ink:#e7edf5;--dim:#8b97a8;
 --dim2:#5f6a7a;--ac:#2dd4bf;--ac2:#7c9cf5;--warn:#f0b429}
@media(prefers-color-scheme:light){:root{--bg:#f7f9fb;--pan:#fff;--line:#e3e8ef;
 --ink:#131820;--dim:#5b6673;--dim2:#94a0af}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--ink);
 font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
 -webkit-font-smoothing:antialiased;padding:0 0 env(safe-area-inset-bottom)}
header{padding:18px 16px 12px;border-bottom:1px solid var(--line);
 position:sticky;top:0;background:var(--bg);z-index:5}
h1{font-size:17px;margin:0;letter-spacing:-.01em}
h1 span{color:var(--dim2);font-weight:400;font-size:13px;margin-left:7px}
.tot{display:flex;gap:14px;margin-top:9px;font-size:13px;color:var(--dim);
 font-variant-numeric:tabular-nums}
.tot b{color:var(--ink);font-weight:640;font-size:15px}
main{padding:0 0 40px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim2);
 margin:22px 16px 8px;font-weight:600}
ul{list-style:none;margin:0;padding:0}
.e{padding:11px 16px;border-bottom:1px solid var(--line)}
.m{display:flex;align-items:center;gap:8px;margin-bottom:3px;font-size:11px}
.k{padding:1px 7px;border-radius:20px;border:1px solid var(--line);color:var(--dim)}
.k.d{border-color:rgba(45,212,191,.45);color:var(--ac)}
.k.c{border-color:rgba(124,156,245,.5);color:var(--ac2)}
.k.p{border-color:rgba(240,180,41,.5);color:var(--warn)}
.pj{color:var(--dim)}
.ts{margin-left:auto;color:var(--dim2);font-variant-numeric:tabular-nums}
.t{font-size:14.5px;line-height:1.45}
.p{display:flex;align-items:center;gap:10px;padding:11px 16px;
 border-bottom:1px solid var(--line);font-size:14px}
.pn{font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc{margin-left:auto;color:var(--dim);font-size:13px;font-variant-numeric:tabular-nums;
 white-space:nowrap}
.pc i{font-style:normal;color:var(--dim2);font-size:11px}
.note{margin:16px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;
 color:var(--dim);font-size:12.5px;line-height:1.5;background:var(--pan)}
.note b{color:var(--ink);font-weight:600}
.note code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;
 background:var(--bg);padding:1px 5px;border-radius:4px;border:1px solid var(--line)}
footer{padding:20px 16px 30px;color:var(--dim2);font-size:11.5px;line-height:1.6}
</style></head><body>
<header>
  <h1>memory<span>${projects.length} projects</span></h1>
  <div class="tot">
    <span><b>${totals.dec}</b> decisions</span>
    <span><b>${totals.con}</b> constraints</span>
    ${totals.pipe ? `<span><b>${totals.pipe}</b> pipelines</span>` : ""}
    <span class="ts">${esc(ago(freshest))} ago</span>
  </div>
</header>
<main>
  <h2>Recent</h2>
  <ul>${feedHtml || '<li class="e"><div class="t">Nothing recorded yet.</div></li>'}</ul>

  <h2>Projects</h2>
  <ul>${projHtml}</ul>

  ${knowledgeHtml}
</main>
<footer>
  Read-only view. This URL is a credential &mdash; it is not indexed, but anyone
  holding it can read every summary above.<br>
  Rotate by changing VIEW_TOKEN in the Cloudflare dashboard; it is separate from
  the connector token, so rotating it does not disturb any MCP client.
</footer>
</body></html>`;
}

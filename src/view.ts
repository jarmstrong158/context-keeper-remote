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

import { hydrate, type EntryRow } from "./db";
import {
  ago, entryDetail, entryRow, loadEntry, loadProject, PAGE_SIZE, search,
} from "./detail";
import { healthReport, healthHtml, projectsHtml } from "./health";

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

  // Two accepted shapes, and the difference is a security one.
  //
  //   /status/<STATUS_TOKEN>  GET. Grants the counts and nothing else.
  //   /mcp/<AUTH_TOKEN>       POST. The full connector -- it also grants recall
  //                           over every promoted item in the team and org
  //                           scopes.
  //
  // The second is supported because it is what an existing deployment already
  // has configured, but the first is what setup installs now: reading three
  // integers should not require storing a credential that can read the
  // knowledge itself. A leak of this Worker's secrets then discloses counts
  // rather than cambium's entire reach.
  const statusOnly = /\/status\/[^/]+\/?$/.test(url);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CAMBIUM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: statusOnly ? "GET" : "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // con-007 in context-keeper: Cloudflare's bot rules 403 a default
        // client UA, and the failure presents as a silent empty panel.
        "user-agent": "context-keeper-view/1.0",
      },
      body: statusOnly
        ? undefined
        : JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "status", arguments: {} },
          }),
    });
    if (!res.ok) return { teamActive: 0, orgActive: 0, teamRepos: 0, error: "http " + res.status };
    const body: any = await res.json();
    // The status route returns the tool's own object; the MCP route wraps it.
    const c = statusOnly ? body?.counts : body?.result?.structuredContent?.counts;
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

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}




interface Rollup {
  project: string;
  decisions: number;
  constraints: number;
  pipelines: number;
  active: number;
  updated_at: string | null;
}

/**
 * Dispatch on query parameters rather than routes.
 *
 * Every page hangs off the same /view path, so they all inherit one cookie
 * check. A second route would mean a second auth surface to keep in step, and
 * the one that drifts is the one that quietly stops checking.
 */
export async function renderView(
  db: D1Database,
  cambiumUrl?: string,
  params?: URLSearchParams,
): Promise<string> {
  const all = params?.get("all") === "1";

  const entryId = params?.get("e");
  if (entryId) {
    const found = await loadEntry(db, entryId);
    if (!found) return shell(`<div class="crumb"><a href="/view">memory</a></div>
      <div class="note"><b>No entry with that id.</b> It may have been pruned, or
      the link may be from a different instance.</div>`);
    return shell(
      entryDetail(found.entry, found.predecessor, found.successor),
      { search: "" },
    );
  }

  const project = params?.get("p");
  if (project) {
    const rows = await loadProject(db, project, all);
    const grouped = ["decision", "constraint", "pipeline"]
      .map((kind) => {
        const of = rows.filter((r) => r.kind === kind);
        if (!of.length) return "";
        return `<h2>${kind}s <span class="cnt">${of.length}</span></h2>
          <ul>${of.map((e) => entryRow(e, false)).join("")}</ul>`;
      })
      .join("");
    return shell(
      `<div class="crumb"><a href="/view">memory</a> / ${esc(project)}</div>
       ${grouped || `<div class="note">Nothing recorded for this project${
         all ? "" : " that is still active"
       }.</div>`}
       ${toggleAll(all, `p=${encodeURIComponent(project)}`)}`,
      { search: "" },
    );
  }

  const q = params?.get("q");
  if (q !== null && q !== undefined) {
    const term = q.trim();
    const rows = term ? await search(db, term, all) : [];
    return shell(
      `<div class="crumb"><a href="/view">memory</a> / search</div>
       ${
         !term
           ? `<div class="note">Type something to search. It looks inside every
              field &mdash; including why a decision was made and what was tried
              first, which is usually where the answer is.</div>`
           : rows.length
             ? `<h2>${rows.length}${rows.length === PAGE_SIZE ? "+" : ""} for &ldquo;${esc(
                 term,
               )}&rdquo;</h2><ul>${rows.map((e) => entryRow(e)).join("")}</ul>`
             : `<div class="note"><b>Nothing matched &ldquo;${esc(term)}&rdquo;.</b>
                ${all ? "" : "Deprecated and superseded entries are hidden &mdash; try including them."}</div>`
       }
       ${term ? toggleAll(all, `q=${encodeURIComponent(term)}`) : ""}`,
      { search: term },
    );
  }

  return renderHome(db, cambiumUrl, params?.get("t") ?? "over");
}

function toggleAll(all: boolean, base: string): string {
  return all
    ? `<div class="more"><a href="/view?${base}">hide deprecated and superseded</a></div>`
    : `<div class="more"><a href="/view?${base}&amp;all=1">include deprecated and superseded</a></div>`;
}

async function renderHome(
  db: D1Database,
  cambiumUrl: string | undefined,
  tab: string,
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

  // Rows are links now. Tapping one opens the rationale, which is the thing
  // this store exists to hold and the thing the phone previously could not see.
  const feedHtml = entries.map((e) => entryRow(e)).join("");


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

  // One tab renders at a time. The desktop dashboard hides the others with
  // JavaScript; here the tab is in the URL instead, so each one is a real page
  // that can be bookmarked, and Health does not pay for a full-table scan on
  // every visit to Recent.
  let main: string;
  if (tab === "proj") {
    main = projectsHtml(await healthReport(db));
  } else if (tab === "know") {
    main = knowledgeHtml;
  } else if (tab === "health") {
    main = healthHtml(await healthReport(db));
  } else {
    main = `<h2>Recent</h2>
  <ul>${feedHtml || '<li class="e"><div class="t">Nothing recorded yet.</div></li>'}</ul>`;
  }

  return shell(main, {
    search: "",
    tab,
    header: `<h1>memory<span>${projects.length} projects</span></h1>
  <div class="tot">
    <span><b>${totals.dec}</b> decisions</span>
    <span><b>${totals.con}</b> constraints</span>
    ${totals.pipe ? `<span><b>${totals.pipe}</b> pipelines</span>` : ""}
    <span class="ts">${esc(ago(freshest))} ago</span>
  </div>`,
  });
}

const TABS: Array<[string, string]> = [
  ["over", "Recent"],
  ["proj", "Projects"],
  ["know", "Knowledge"],
  ["health", "Health"],
];

/**
 * The document around every page.
 *
 * Extracted so detail, project and search pages cannot drift from the home
 * page's head -- and specifically so they cannot lose the manifest link, which
 * is what makes the thing installable. A page reachable from the home screen
 * that quietly dropped its own manifest would still work and would stop being
 * an app.
 */
function shell(
  main: string,
  opts: { search?: string; header?: string; tab?: string } = {},
): string {
  const header =
    opts.header ??
    `<h1><a href="/view" class="home">memory</a></h1>`;

  // Links, not buttons: the desktop dashboard swaps tabs with JavaScript, which
  // it can afford because it is one self-contained file with all the data
  // already in it. Here each tab is a real URL -- bookmarkable, shareable,
  // survivable across an app restart, and reachable with no script at all.
  const tabs = opts.tab
    ? `<nav class="tabs">${TABS.map(
        ([id, label]) =>
          `<a class="tab${id === opts.tab ? " on" : ""}" href="/view${
            id === "over" ? "" : `?t=${id}`
          }">${label}</a>`,
      ).join("")}</nav>`
    : "";

  // GET, so a search is a plain URL that can be bookmarked, shared between
  // devices, and re-run by reloading. No JS involved.
  const searchBox =
    opts.search === undefined
      ? ""
      : `<form class="sf" method="get" action="/view" role="search">
           <input type="search" name="q" value="${esc(opts.search)}"
             placeholder="search every field" autocapitalize="off"
             autocorrect="off" spellcheck="false" enterkeyhint="search">
         </form>`;

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

/* --- rows became links; keep them looking like rows --- */
.e a,.p a{color:inherit;text-decoration:none;display:block}
.p a{display:flex;align-items:center;gap:10px;width:100%}
.e{padding:0}
.e a{padding:11px 16px}
.p{padding:0}
.p a{padding:11px 16px}
.e a:active,.p a:active{background:var(--pan)}
.e.dead .t{color:var(--dim)}
.dd{padding:1px 7px;border-radius:20px;border:1px solid var(--line);color:var(--dim2);
 font-size:10px;text-transform:uppercase;letter-spacing:.04em}
h2 .cnt{color:var(--dim2);font-weight:400;margin-left:6px}

/* --- search --- */
.sf{margin-top:10px}
.sf input{width:100%;padding:9px 12px;border-radius:9px;border:1px solid var(--line);
 background:var(--pan);color:var(--ink);font-size:16px;-webkit-appearance:none}
.sf input::placeholder{color:var(--dim2)}
.sf input:focus{outline:none;border-color:var(--ac)}

/* --- breadcrumb + detail --- */
.crumb{padding:12px 16px 0;font-size:12px;color:var(--dim2)}
.crumb a{color:var(--dim);text-decoration:none}
.home{color:inherit;text-decoration:none}
.det{padding:10px 16px 30px}
.det .m{margin:8px 0 6px}
.dt{font-size:19px;line-height:1.35;margin:0 0 14px;letter-spacing:-.01em;font-weight:620}
.det section{margin:18px 0}
.det h3{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim2);
 margin:0 0 5px;font-weight:600}
.det p{margin:0 0 9px;font-size:14.5px;line-height:1.6;color:var(--ink)}
.det.dead .dt{color:var(--dim)}

/* --- the supersession trail --- */
.trail{display:block;padding:10px 12px;margin:0 0 14px;border-radius:9px;
 border:1px solid var(--line);background:var(--pan);text-decoration:none;
 color:var(--dim);font-size:13px;line-height:1.45}
.trail span{display:block;font-size:10.5px;text-transform:uppercase;
 letter-spacing:.05em;color:var(--dim2);margin-bottom:3px}
.trail.now{border-color:rgba(240,180,41,.5)}
.trail.now span{color:var(--warn)}

.metaGrid{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 16px;font-size:12.5px}
.kv span{color:var(--dim2);margin-right:6px}
.kv b{font-weight:560;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.steps,.bul,.alts{margin:0;padding-left:18px;font-size:14px;line-height:1.55}
.steps li,.bul li{margin-bottom:5px}
.alts{list-style:none;padding:0}
.alts li{margin-bottom:9px}
.alts b{display:block;font-weight:580;font-size:14px}
.alts span{color:var(--dim);font-size:13.5px;line-height:1.5}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 0}
.chip{padding:3px 9px;border-radius:20px;border:1px solid var(--line);color:var(--dim);
 font-size:11.5px;text-decoration:none;font-family:ui-monospace,Menlo,monospace}
.idline{margin-top:22px;padding-top:12px;border-top:1px solid var(--line);
 color:var(--dim2);font-size:11px;font-family:ui-monospace,Menlo,monospace}
.tabs{display:flex;gap:4px;margin-top:11px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.tab{padding:6px 12px;border-radius:7px;border:1px solid transparent;color:var(--dim);
 font-size:13px;text-decoration:none;white-space:nowrap}
.tab.on{background:var(--pan);border-color:var(--line);color:var(--ink)}

/* --- health --- */
.health{padding:4px 16px 0}
.hrow{margin-bottom:16px}
.hl{font-size:13px;font-weight:560}
.trk{height:6px;border-radius:4px;background:var(--pan);border:1px solid var(--line);
 margin:5px 0 4px;overflow:hidden}
.fill{height:100%;border-radius:4px}
.fill.bad{background:#f2545b}
.fill.warn{background:var(--warn)}
.hv{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.hv span{color:var(--dim2)}
.hn{font-size:11.5px;color:var(--dim2);line-height:1.5;margin-top:3px}
.tw{overflow-x:auto;padding:0 16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--dim2);font-size:11px;text-transform:uppercase;
 letter-spacing:.05em;padding:8px 6px;border-bottom:1px solid var(--line)}
td{padding:9px 6px;border-bottom:1px solid var(--line)}
td a{color:inherit;text-decoration:none;font-weight:560}
.num{text-align:right;font-variant-numeric:tabular-nums;color:var(--dim)}
.num.bad{color:#f2545b}
.more{padding:14px 16px}
.more a{color:var(--dim);font-size:12.5px}
</style></head><body>
<header>
  ${header}
  ${searchBox}
  ${tabs}
</header>
<main>${main}</main>
<footer>
  Read-only view. This URL is a credential &mdash; it is not indexed, but anyone
  holding it can read every summary above.<br>
  Rotate by changing VIEW_TOKEN in the Cloudflare dashboard; it is separate from
  the connector token, so rotating it does not disturb any MCP client.
</footer>
</body></html>`;
}

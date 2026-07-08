# context-keeper-remote

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jarmstrong158/context-keeper-remote)

_Part of the [xylem](https://github.com/jarmstrong158/xylem) stack._

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that
exposes context-keeper's rationale store (decisions, pipelines, constraints) over
Streamable HTTP. It works as a **claude.ai custom connector**, including on mobile,
so your project's decisions and constraints are available from any Claude session —
no PC left running, no tunnel.

**Self-host your own copy in a few clicks with the button above** — Cloudflare
copies this repo into your GitHub account, creates a fresh D1 database for you, and
deploys the Worker. Then you add one secret and paste a URL into Claude. Full
walkthrough below; every step is a click, no command line anywhere.

> The maintainer's own instance runs at
> `https://context-keeper-remote.jarmstrong158.workers.dev`. Yours will be at your
> own subdomain after you deploy.

### Why it's built this way

- **Worker, not tunnel** — no "PC must be on" dependency.
- **D1, not KV** — row-level writes and `WHERE` queries; two writers (desktop +
  mobile) don't clobber each other the way whole-file JSON read-modify-write does.
- **Stateless handler, no Durable Objects** — the tools are stateless RPCs against
  D1, so the Worker runs on the Cloudflare **free plan**.
- **Secret-path auth** — claude.ai custom connectors don't reliably send custom
  bearer headers, so the token is the last path segment of the URL. The URL is the
  credential.
- **Self-migrating** — the Worker creates its own D1 schema at runtime, so a
  brand-new empty database needs **no manual SQL** (verified by a cold-start test).

---

## Self-host it (one-click, no command line)

### Step 1 — Click "Deploy to Cloudflare"

Click the **Deploy to Cloudflare** button at the top of this page. Cloudflare will:

1. Ask you to authorize GitHub and pick an account — it **copies this repo into
   your GitHub account** (you get your own repo).
2. **Automatically create a new D1 database** in your Cloudflare account and bind it
   to the Worker. (This works because the Worker's config declares the database
   binding without a hard-coded id, so Cloudflare provisions a fresh one for you.)
3. Set up **Workers Builds** so every push to your new repo redeploys automatically.
4. Build and deploy the Worker.

When it finishes, your Worker is live at
`https://context-keeper-remote.<your-subdomain>.workers.dev`. Note that URL — you'll
need it in Step 3. (You can always find it under **Workers & Pages** in the
dashboard.)

> Nothing to configure in the repo, and **no SQL to run** — the database starts
> empty and the Worker creates its tables on the first request.

### Step 2 — Add the `AUTH_TOKEN` secret (Cloudflare dashboard)

The Worker refuses every request until it has an auth token, so set one:

1. Cloudflare dashboard → **Workers & Pages** → your **context-keeper-remote**
   Worker.
2. **Settings** → **Variables and Secrets** → **Add**.
3. Type: **Secret**. Name: `AUTH_TOKEN`. Value: a long random string (32+ characters
   — treat it like a password). Save/Deploy.

That value is your connector's password. Keep it somewhere safe; you'll paste it in
the next step.

<details>
<summary>Also deploying the companion <code>agentsync-remote</code> worker?</summary>

`agentsync-remote` uses the same `AUTH_TOKEN` scheme, and **additionally** needs, in
*its* Worker's **Variables and Secrets**:

- a **Secret** named `GH_PAT` — a GitHub personal access token, and
- a **Variable** named `REPO` — set to the `owner/repo` it should sync.

Those two do **not** apply to context-keeper-remote (this repo) — it only needs
`AUTH_TOKEN`. See the `agentsync-remote` README for its specifics.
</details>

### Step 3 — Add the custom connector in claude.ai

1. claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Paste your Worker URL with the token as the final path segment:

   ```
   https://context-keeper-remote.<your-subdomain>.workers.dev/mcp/<AUTH_TOKEN>
   ```

   Replace `<your-subdomain>` with your Worker's subdomain (Step 1) and
   `<AUTH_TOKEN>` with the exact value you set (Step 2).
3. Save. The tools (`record_decision`, `get_context`, `query_entries`, …) are now
   available in your Claude sessions.

**Check it works:** ask Claude to call `get_project_summary`. If it answers, the
whole chain (deploy → auto-provisioned D1 → auto-migration → auth) is working.

### Step 4 — Migrate existing local data (optional)

If you already run local context-keeper, ask Claude (with the connector enabled) to
call **`import_entries`**, pasting each file's contents:

- `decisions.json` → `import_entries(project, kind="decision", entries=[...])`
- `pipelines.json` → `import_entries(project, kind="pipeline", entries=[...])`
- `constraints.json` → `import_entries(project, kind="constraint", entries=[...])`

Incoming ids are preserved; existing ids are reported, never overwritten.

---

## ⚠️ Security: the connector URL is a credential

The URL you paste into Claude **embeds `AUTH_TOKEN`** as its last path segment.
Anyone who has the full `…/mcp/<AUTH_TOKEN>` URL can read and write your entire
store. Treat it exactly like a password:

- Don't share it, screenshot it, or paste it anywhere it could be logged.
- Requests to any other path, or with the wrong token, get a bare `404` with no
  detail (a valid token used with a non-POST method gets `405`).
- **To rotate:** change `AUTH_TOKEN` in the Cloudflare dashboard (Step 2). This
  **immediately invalidates every old URL** — any connector using the previous
  token starts getting `404`s until you update it in claude.ai (Step 3) with the new
  value.

---

## Tools

Every tool takes an optional `project`; if omitted it falls back to the configured
`default_project` (set it once with `set_config`, key `default_project`).

| Tool | Purpose |
| --- | --- |
| `set_config` / `get_config` | Config, including `default_project`. |
| `record_decision` | Record a decision: `summary`, `problem`, `why_chosen`, `what_we_tried`, `tradeoffs`, `tags`. |
| `record_constraint` | Record a rule that must hold: `rule`, `reason`, `tags`. |
| `record_pipeline` | Record a reusable process: `name`, `purpose`, `steps` (extra fields kept verbatim). |
| `get_context` | Relevance-ranked retrieval for a query (keyword scoring; excludes deprecated unless `include_deprecated`). |
| `query_entries` | Structured filters: `id`, `kind`, `tags` (all must match), `status` (`active`/`deprecated`/`all`), free `text`. |
| `get_project_summary` | Counts by kind and status, plus the ids present. |
| `update_entry` | Merge `patch` fields into an entry's payload; optionally change `status`. |
| `deprecate_entry` | Mark deprecated, optionally linking `superseded_by`. |
| `reload_constraints` | Compact list of the active constraints. |
| `prune_stale` | Delete old deprecated entries (**dry run by default**; pass `dry_run=false`). |
| `verify_quality` | Flag entries missing rationale-bearing fields. |
| `export_markdown` | Render entries as a DECISIONS.md-style document. |
| `import_entries` | Bulk import from the local JSON store format (preserves ids, reports collisions). |

### Entry conventions

- **Decisions** use `summary`, `problem`, `why_chosen`, `what_we_tried`,
  `tradeoffs`, `tags`. The deprecated `rationale` field is accepted on input and
  mapped to `why_chosen` when `why_chosen` is absent.
- **Constraints** use `rule`, `reason`, `tags`.
- **Pipelines** use `name`, `purpose`, `steps`, plus any extra fields you pass.
- **ids** are per project+kind: `dec-001`, `pipe-003`, `con-012`. Because the same
  id recurs across projects, the D1 primary key is composite `(project, id)`.

---

## For maintainers / contributors

Everything above is for self-hosters. This section is for working on the code
itself.

### Config layout: how one repo serves both the button and CI

`wrangler.toml` has two profiles:

- **Default (top level)** — the D1 binding is declared **without** a `database_id`.
  This is what the Deploy button, `wrangler dev`, and the local test suite use. With
  no id, Cloudflare auto-provisions a fresh database for each self-hoster.
- **`[env.production]`** — pins the maintainer's real `database_id` and the Worker
  `name`. The maintainer's CI deploys with `wrangler deploy --env production` so it
  keeps hitting the same database and the same URL. Self-hosters never touch this
  env.

### Deploy pipeline (maintainer only)

`.github/workflows/deploy.yml` runs on push to `main`, and is gated with
`if: github.repository == 'jarmstrong158/context-keeper-remote'` so forks (which
deploy via Workers Builds instead) don't run failing Actions. Steps: checkout →
Node 22 (Wrangler needs ≥ 22) → `npm ci` → `npm test` → `wrangler deploy --env
production`. Tests gate the deploy. It reads two GitHub repo secrets,
`CLOUDFLARE_API_TOKEN` (needs **Workers Scripts: Edit**) and `CLOUDFLARE_ACCOUNT_ID`
— **distinct** from the Worker's own `AUTH_TOKEN`.

### Local development

No network and no Cloudflare credentials required — tests run against a local
workerd D1 via `@cloudflare/vitest-pool-workers`. Requires **Node ≥ 22**.

```bash
npm install
npm test          # vitest: migrations, cold-start, CRUD, id sequencing, auth, import, ...
npm run typecheck # tsc --noEmit
```

### Live smoke test

After a deploy, from any machine with network access:

```bash
WORKER_URL="https://context-keeper-remote.<subdomain>.workers.dev/mcp/<AUTH_TOKEN>" \
  node scripts/smoke-test.mjs
```

Runs `initialize → tools/list → record_decision → query_entries` against the live
worker.

### Layout

```
src/index.ts             fetch handler: token check -> migrations -> MCP dispatch
src/mcp.ts               stateless Streamable HTTP MCP server (createMcpHandler)
src/db.ts                D1 access + runtime migration runner + id generation
src/entries.ts           payload normalization, insert-with-retry, keyword scoring
src/tools/*.ts           one module per tool group
schema.sql               reference copy of the DDL the migration runner embeds
wrangler.toml            default (auto-provision) + [env.production] (pinned) config
.github/workflows/deploy.yml   test-then-deploy on push to main (maintainer repo)
scripts/smoke-test.mjs   live JSON-RPC round-trip check
test/                    vitest suite (local workerd D1, no network)
```

### Troubleshooting the maintainer deploy

| Symptom in the Actions log | Cause | Fix |
| --- | --- | --- |
| `Wrangler requires at least Node.js v22.0.0` | Node < 22 | Already set to Node 22 in `deploy.yml`. |
| `it's necessary to set a CLOUDFLARE_API_TOKEN environment variable` | Deploy secrets missing | Add both GitHub repo secrets. |
| `No route for that URI [code: 7000]` / `object identifier is invalid [code: 7003]` | API token lacks Workers permission, or wrong `CLOUDFLARE_ACCOUNT_ID` | Use an "Edit Cloudflare Workers" token; confirm the account id. |
| Deploys succeed but every call returns `404` | Worker `AUTH_TOKEN` not set, or the URL's token doesn't match it | Set/verify `AUTH_TOKEN` in the Cloudflare dashboard. |

---

## Related

- [context-keeper](https://github.com/jarmstrong158/context-keeper) — the local stdio original this Worker hosts as a remote transport.
- [xylem](https://github.com/jarmstrong158/xylem) — the stack this is part of.

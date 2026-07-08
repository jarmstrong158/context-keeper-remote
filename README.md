# context-keeper-remote

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that
exposes context-keeper's rationale store (decisions, pipelines, constraints) over
Streamable HTTP. It works as a **claude.ai custom connector**, including on mobile,
so your project's decisions and constraints are available from any Claude session
without your PC being on.

**Live deployment:** `https://context-keeper-remote.jarmstrong158.workers.dev`

## Why it's built this way

- **Worker, not tunnel** — no "PC must be on" dependency.
- **D1, not KV** — row-level writes and `WHERE` queries; two writers (desktop +
  mobile) don't clobber each other the way whole-file JSON read-modify-write does.
- **Stateless handler, no Durable Objects** — the tools are stateless RPCs against
  D1, so the Worker runs on the Cloudflare **free plan**.
- **Secret-path auth** — claude.ai custom connectors don't reliably send custom
  bearer headers, so the token is the last path segment of the URL. The URL itself
  is the credential.
- **Self-migrating** — the Worker creates its own D1 schema at runtime (idempotent
  `CREATE TABLE IF NOT EXISTS`, run once per isolate). There is **no manual SQL
  step**.

---

## Two different sets of credentials (read this first)

This trips people up. There are **two** unrelated groups of secrets:

| Secret | Lives in | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | **GitHub** repo → Settings → Secrets and variables → Actions | Let GitHub Actions **deploy** the Worker to Cloudflare. |
| `AUTH_TOKEN` | **Cloudflare** dash → Worker → Settings → Variables and Secrets | Guards the running Worker. It's the token in the connector URL. |

The GitHub ones are for *shipping the code*. The Cloudflare one is what *callers
authenticate with*. They are not interchangeable.

---

## First-time setup

Everything is doable from a phone: the Cloudflare dashboard, the GitHub web UI, and
claude.ai. You never need a terminal.

### 1. Create the D1 database

Cloudflare dashboard → **Storage & Databases → D1 → Create database**.

- Name it (e.g. `context-keeper`).
- Open it and **copy the Database ID**.
- Put that ID into `wrangler.toml` (edit on GitHub with the pencil icon, commit to
  `main`):

  ```toml
  [[d1_databases]]
  binding = "DB"
  database_name = "context-keeper"
  database_id = "your-real-id-here"   # currently: 4ed77245-807b-4fa8-a50d-c71cfd3c704d
  ```

  You do **not** run any SQL — the Worker creates its tables on the first request.

### 2. Set the Worker's `AUTH_TOKEN` (Cloudflare)

Your Worker → **Settings → Variables and Secrets → Add** a **Secret**:

- Name: `AUTH_TOKEN`
- Value: a long random string (treat it like a password — 32+ random characters).

Until this is set, **every request returns `404`** — the Worker refuses to
authenticate against an empty token, on purpose.

### 3. Add the deploy credentials (GitHub)

GitHub repo → **Settings → Secrets and variables → Actions → New repository
secret**. Add both (names must match exactly, they're case-sensitive):

- `CLOUDFLARE_ACCOUNT_ID` — your account id
  (`d97f8b6f83ced8ffc5e4a2faf9501524`; it's the first path segment of any
  dashboard URL).
- `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with **Account → Workers
  Scripts → Edit** permission on that account. The **"Edit Cloudflare Workers"**
  token template covers it. (A token that lacks Workers permission fails the deploy
  with `No route for that URI [code: 7000]`.)

### 4. Deploy

Deployment is a **GitHub Actions** workflow (`.github/workflows/deploy.yml`):
every push to `main` runs the test suite and, only if it passes, runs
`wrangler deploy`. So just push to `main` (steps 1 and 3 already do that by
committing) and watch the **Actions** tab. A green run means the Worker is live at
`https://context-keeper-remote.<your-subdomain>.workers.dev`.

### 5. Add the connector in claude.ai

claude.ai → **Settings → Connectors → Add custom connector**. Use the live URL with
the `AUTH_TOKEN` (from step 2) as the final path segment:

```
https://context-keeper-remote.jarmstrong158.workers.dev/mcp/<AUTH_TOKEN>
```

The tools (`record_decision`, `get_context`, `query_entries`, …) are now available
in your Claude sessions. A good first call is `get_project_summary` — if it
answers, the whole chain (deploy + D1 auto-migration + auth) works.

### 6. Migrate your local store (optional)

If you already have local context-keeper data, open any Claude session with the
connector enabled and ask it to call **`import_entries`**, pasting the contents of
each file:

- `decisions.json` → `import_entries(project, kind="decision", entries=[...])`
- `pipelines.json` → `import_entries(project, kind="pipeline", entries=[...])`
- `constraints.json` → `import_entries(project, kind="constraint", entries=[...])`

Incoming `id`s are preserved. If an id already exists it's reported, never
overwritten.

---

## Security note

**The connector URL is the credential.** Anyone with the full
`…/mcp/<AUTH_TOKEN>` URL can read and write your store. Don't share it or paste it
where it'll be logged. To **rotate**: change `AUTH_TOKEN` in the Cloudflare
dashboard (step 2) and update the connector URL in claude.ai (step 5). Requests to
any other path, or with the wrong token, get a bare `404` with no detail (a valid
token with a non-POST method gets `405`).

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
| `prune_stale` | Delete old deprecated entries (**dry run by default**; pass `dry_run=false` to delete). |
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

## Deployment pipeline

`.github/workflows/deploy.yml`, triggered on push to `main`:

1. `checkout`
2. Set up **Node 22** (Wrangler 4.x requires Node ≥ 22)
3. `npm ci`
4. `npm test` — the vitest suite. **If tests fail the job stops here and nothing
   deploys.**
5. `npx wrangler deploy` — reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   from the repo secrets (by name only; values are never printed).

---

## Development

Local, no network and no Cloudflare credentials required — tests run against a local
workerd D1 via `@cloudflare/vitest-pool-workers`. Requires **Node ≥ 22**.

```bash
npm install
npm test          # vitest: migrations, CRUD, id sequencing, mapping, auth, import, ...
npm run typecheck # tsc --noEmit
```

Do not run `wrangler deploy` / `wrangler d1` locally in the build environment — that
happens in CI on push to `main`.

### Live smoke test

After a deploy, from any machine with network access:

```bash
WORKER_URL="https://context-keeper-remote.jarmstrong158.workers.dev/mcp/<AUTH_TOKEN>" \
  node scripts/smoke-test.mjs
```

It runs `initialize → tools/list → record_decision → query_entries` against the live
worker and prints per-step `ok:` lines.

---

## Troubleshooting the deploy

| Symptom in the Actions log | Cause | Fix |
| --- | --- | --- |
| `Wrangler requires at least Node.js v22.0.0` | Node < 22 in the workflow | Already set to Node 22 in `deploy.yml`. |
| `it's necessary to set a CLOUDFLARE_API_TOKEN environment variable` | Deploy secrets missing | Add both GitHub secrets (setup step 3). |
| `No route for that URI [code: 7000]` / `object identifier is invalid [code: 7003]` | API token lacks Workers permission, or wrong/typo'd `CLOUDFLARE_ACCOUNT_ID` | Use an "Edit Cloudflare Workers" token; confirm the account id. |
| Connector works in Actions but every call returns `404` | Worker `AUTH_TOKEN` not set, or the URL's token doesn't match it | Set/verify `AUTH_TOKEN` in the Cloudflare dashboard (setup step 2). |

---

## Layout

```
src/index.ts             fetch handler: token check -> migrations -> MCP dispatch
src/mcp.ts               stateless Streamable HTTP MCP server (createMcpHandler)
src/db.ts                D1 access + runtime migration runner + id generation
src/entries.ts           payload normalization, insert-with-retry, keyword scoring
src/tools/*.ts           one module per tool group
schema.sql               reference copy of the DDL the migration runner embeds
wrangler.toml            D1 binding (database_id)
.github/workflows/deploy.yml   test-then-deploy on push to main
scripts/smoke-test.mjs   live JSON-RPC round-trip check
test/                    vitest suite (local workerd D1, no network)
```

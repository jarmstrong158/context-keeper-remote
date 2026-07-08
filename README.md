# context-keeper-remote

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that
exposes context-keeper's rationale store (decisions, pipelines, constraints) over
Streamable HTTP. It works as a **claude.ai custom connector**, including on mobile,
so your project's decisions and constraints are available from any Claude session
without your PC being on.

- **Worker, not tunnel** — no "PC must be on" dependency.
- **D1, not KV** — row-level writes and `WHERE` queries; two writers (desktop +
  mobile) don't clobber each other.
- **Stateless handler, no Durable Objects** — runs on the Workers free plan.
- **Secret-path auth** — the connector URL itself is the credential.
- **Self-migrating** — the Worker creates its own D1 schema at runtime; there is
  no manual SQL step.

---

## Setup (phone-only, ~5 minutes)

Everything is done in the Cloudflare dashboard and claude.ai. You never need a
terminal.

### 1. Create the D1 database

Cloudflare dashboard → **Storage & Databases → D1 → Create database**.

- Name it (e.g. `context-keeper`).
- Open it and **copy the Database ID**.
- Paste that ID into `wrangler.toml`, replacing `PASTE_D1_ID_HERE`:

  ```toml
  [[d1_databases]]
  binding = "DB"
  database_name = "context-keeper"
  database_id = "your-real-id-here"
  ```

  Edit the file directly on GitHub (pencil icon) and commit to `main`.

  > You do **not** need to run any SQL. The Worker creates its tables
  > automatically the first time it handles a request.

### 2. Add the auth token secret

Your Worker → **Settings → Variables and Secrets → Add** a **Secret**:

- Name: `AUTH_TOKEN`
- Value: a long random string (treat it like a password — 32+ random characters).

This secret is never stored in the repo or in GitHub.

### 3. Deploy

Cloudflare's GitHub App (Workers Builds) is connected to this repo, so **pushing
to `main` builds and deploys automatically**. Editing `wrangler.toml` in step 1
already triggered a deploy; any later push to `main` redeploys.

Find your worker's URL in the dashboard, e.g.
`https://context-keeper-remote.<account>.workers.dev`.

### 4. Add the connector in claude.ai

claude.ai → **Settings → Connectors → Add custom connector**. Use the URL with
the token as the final path segment:

```
https://context-keeper-remote.<account>.workers.dev/mcp/<AUTH_TOKEN>
```

That's it — the tools (record_decision, get_context, query_entries, …) are now
available in your Claude sessions.

### 5. Migrate your local store (optional)

If you already have local context-keeper data, open any Claude session with the
connector enabled and ask it to call **`import_entries`**, pasting the contents of
each file:

- `decisions.json` → `import_entries(project, kind="decision", entries=[...])`
- `pipelines.json` → `import_entries(project, kind="pipeline", entries=[...])`
- `constraints.json` → `import_entries(project, kind="constraint", entries=[...])`

Incoming `id`s are preserved. If an id already exists it is reported, never
overwritten.

---

## Security note

**The URL is the credential.** Anyone with the full
`…/mcp/<AUTH_TOKEN>` URL can read and write your store. Don't share it. To
**rotate**, change `AUTH_TOKEN` in the dashboard (step 2) and update the connector
URL in claude.ai (step 4). Requests to any other path — or with the wrong token —
get a bare `404` with no detail.

---

## Tools

Every tool takes an optional `project`; if omitted it falls back to the configured
`default_project` (set it once with `set_config`).

| Tool | Purpose |
| --- | --- |
| `set_config` / `get_config` | Config, incl. `default_project`. |
| `record_decision` | Record a decision (summary, problem, why_chosen, what_we_tried, tradeoffs, tags). |
| `record_constraint` | Record a rule that must hold (rule, reason, tags). |
| `record_pipeline` | Record a reusable process (name, purpose, steps). |
| `get_context` | Relevance-ranked retrieval for a query (excludes deprecated by default). |
| `query_entries` | Structured filters: id, kind, tags, status, free text. |
| `get_project_summary` | Counts by kind/status and the ids present. |
| `update_entry` | Merge patch fields into an entry; optionally change status. |
| `deprecate_entry` | Mark deprecated, optionally linking `superseded_by`. |
| `reload_constraints` | Compact list of active constraints. |
| `prune_stale` | Delete old deprecated entries (dry-run by default). |
| `verify_quality` | Flag entries missing rationale-bearing fields. |
| `export_markdown` | Render entries as a DECISIONS.md document. |
| `import_entries` | Bulk import from local JSON store format. |

### Decision payload fields

Decisions use `summary`, `problem`, `why_chosen`, `what_we_tried`, `tradeoffs`,
`tags`. The deprecated `rationale` field is accepted on input and mapped to
`why_chosen` when `why_chosen` is absent.

---

## Development

Local, no network / no Cloudflare credentials required — tests run against a local
workerd D1 via `@cloudflare/vitest-pool-workers`.

```bash
npm install
npm test          # vitest: migrations, CRUD, id sequencing, auth, import, ...
npm run typecheck # tsc --noEmit
```

Do **not** run `wrangler deploy` / `wrangler d1` here: deploys go through Workers
Builds on push to `main`, and this environment has no Cloudflare egress.

### Live smoke test

After deploying, from any machine with network access:

```bash
WORKER_URL="https://context-keeper-remote.<account>.workers.dev/mcp/<AUTH_TOKEN>" \
  node scripts/smoke-test.mjs
```

It runs `initialize → tools/list → record_decision → query_entries` against the
live worker.

## Layout

```
src/index.ts       fetch handler: token check -> migrations -> MCP dispatch
src/mcp.ts         stateless Streamable HTTP MCP server (createMcpHandler)
src/db.ts          D1 access + runtime migration runner + id generation
src/entries.ts     payload normalization, insert-with-retry, keyword scoring
src/tools/*.ts     one module per tool group
schema.sql         reference copy of the DDL the migration runner embeds
wrangler.toml      D1 binding (paste your database_id)
scripts/smoke-test.mjs   live JSON-RPC round-trip check
test/              vitest suite (local workerd D1, no network)
```

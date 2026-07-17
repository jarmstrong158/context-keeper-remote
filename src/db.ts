// D1 access layer: lazy runtime migrations + shared row helpers.
//
// The Worker owns its own schema. Migrations are idempotent
// (CREATE ... IF NOT EXISTS) and memoized per isolate so that the batch runs
// at most once per Worker instance, before the first query.

export type Kind = "decision" | "pipeline" | "constraint";
export type Status = "active" | "deprecated";

export const KINDS: Kind[] = ["decision", "pipeline", "constraint"];

// id prefix per kind. ids look like 'dec-001', 'pipe-003', 'con-012'.
export const PREFIX: Record<Kind, string> = {
  decision: "dec",
  pipeline: "pipe",
  constraint: "con",
};

// Reverse lookup so we can infer a kind from an id prefix when needed.
export const KIND_BY_PREFIX: Record<string, Kind> = {
  dec: "decision",
  pipe: "pipeline",
  con: "constraint",
};

// The global (project-less) scope used for config like `default_project`.
export const GLOBAL_SCOPE = "";

const MIGRATIONS = [
  // ids ('dec-001', ...) are generated per project+kind, so they repeat across
  // projects. The primary key is therefore composite (project, id) rather than
  // id alone — otherwise a second project's 'dec-001' would collide with the
  // first project's. This corrects the single-project assumption in the
  // reference DDL for this multi-project table.
  `CREATE TABLE IF NOT EXISTS entries (
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    project TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_by TEXT,
    payload TEXT NOT NULL,
    PRIMARY KEY (project, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_pks ON entries(project, kind, status)`,
  `CREATE TABLE IF NOT EXISTS config (
    project TEXT,
    key TEXT,
    value TEXT,
    PRIMARY KEY (project, key)
  )`,
];

// Memoize per D1 binding instance so repeated requests in one isolate skip the
// migration batch after the first successful run.
const migrated = new WeakSet<D1Database>();

export async function runMigrations(db: D1Database): Promise<void> {
  if (migrated.has(db)) return;
  await db.batch(MIGRATIONS.map((sql) => db.prepare(sql)));
  migrated.add(db);
}

// --- row shape --------------------------------------------------------------

export interface EntryRow {
  id: string;
  kind: Kind;
  project: string;
  status: Status;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  payload: string;
}

// The hydrated form we hand back to callers/tools.
export interface Entry {
  id: string;
  kind: Kind;
  project: string;
  status: Status;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  payload: Record<string, unknown>;
}

export function hydrate(row: EntryRow): Entry {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    project: row.project,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    superseded_by: row.superseded_by,
    payload,
  };
}

// --- config -----------------------------------------------------------------

export async function getConfig(
  db: D1Database,
  key: string,
  project: string = GLOBAL_SCOPE,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM config WHERE project = ? AND key = ?`)
    .bind(project, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setConfig(
  db: D1Database,
  key: string,
  value: string,
  project: string = GLOBAL_SCOPE,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO config (project, key, value) VALUES (?, ?, ?)
       ON CONFLICT(project, key) DO UPDATE SET value = excluded.value`,
    )
    .bind(project, key, value)
    .run();
}

// Resolve the effective project: explicit arg wins, else config default_project.
// Throws a clear, actionable error when neither is set.
export async function resolveProject(
  db: D1Database,
  project?: string | null,
): Promise<string> {
  const explicit = (project ?? "").trim();
  if (explicit) return explicit;
  const fallback = await getConfig(db, "default_project");
  if (fallback && fallback.trim()) return fallback.trim();
  throw new Error(
    "No project given and no default_project configured. Pass `project`, or call set_config with key 'default_project'.",
  );
}

// --- id generation ----------------------------------------------------------

// Next zero-padded id for a project+kind: max numeric suffix + 1.
export async function nextId(db: D1Database, project: string, kind: Kind): Promise<string> {
  const sep = PREFIX[kind] + "-";
  // substr is 1-indexed in SQLite; start just past the separator. The start
  // position is inlined (not bound) because D1 does not evaluate a bound
  // parameter in the substr() length position, which would make MAX() null and
  // hand out a duplicate id. `start` is a trusted integer derived from the
  // fixed prefix, so inlining is injection-safe.
  const start = sep.length + 1;
  const row = await db
    .prepare(
      `SELECT MAX(CAST(substr(id, ${start}) AS INTEGER)) AS m
         FROM entries WHERE project = ? AND kind = ?`,
    )
    .bind(project, kind)
    .first<{ m: number | null }>();
  const next = (row?.m ?? 0) + 1;
  return sep + String(next).padStart(3, "0");
}

// --- fetch helpers ----------------------------------------------------------

export async function getEntry(
  db: D1Database,
  project: string,
  id: string,
): Promise<Entry | null> {
  const row = await db
    .prepare(`SELECT * FROM entries WHERE project = ? AND id = ?`)
    .bind(project, id)
    .first<EntryRow>();
  return row ? hydrate(row) : null;
}

export interface ListOpts {
  kind?: Kind;
  status?: Status;
  includeDeprecated?: boolean;
}

export async function listEntries(
  db: D1Database,
  project: string,
  opts: ListOpts = {},
): Promise<Entry[]> {
  const clauses = ["project = ?"];
  const binds: unknown[] = [project];
  if (opts.kind) {
    clauses.push("kind = ?");
    binds.push(opts.kind);
  }
  if (opts.status) {
    clauses.push("status = ?");
    binds.push(opts.status);
  } else if (!opts.includeDeprecated) {
    clauses.push("status = 'active'");
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM entries WHERE ${clauses.join(" AND ")}
       ORDER BY kind, id`,
    )
    .bind(...binds)
    .all<EntryRow>();
  return (results ?? []).map(hydrate);
}

// --- org registry -----------------------------------------------------------

// Per-project rollup: how much memory each project holds. Enumerating this is
// the reliable way to discover every project (and its EXACT, case-sensitive
// name) without probing names one at a time.
export interface ProjectStat {
  project: string;
  decisions: number; // active only
  constraints: number; // active only
  pipelines: number; // active only
  active: number;
  deprecated: number;
  total: number;
  updated_at: string | null; // most recent entry mutation in the project
}

// Every project that has at least one entry, with active per-kind counts and
// the last-updated time. One GROUP BY over the whole table — the org registry.
export async function listProjects(db: D1Database): Promise<ProjectStat[]> {
  const active = (kind: Kind) =>
    `SUM(CASE WHEN kind = '${kind}' AND status = 'active' THEN 1 ELSE 0 END)`;
  const { results } = await db
    .prepare(
      `SELECT project,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'deprecated' THEN 1 ELSE 0 END) AS deprecated,
         ${active("decision")} AS decisions,
         ${active("constraint")} AS constraints,
         ${active("pipeline")} AS pipelines,
         MAX(updated_at) AS updated_at
       FROM entries
       GROUP BY project
       ORDER BY decisions DESC, project ASC`,
    )
    .all<{
      project: string;
      total: number;
      active: number;
      deprecated: number;
      decisions: number;
      constraints: number;
      pipelines: number;
      updated_at: string | null;
    }>();
  return (results ?? []).map((r) => ({
    project: r.project,
    decisions: Number(r.decisions) || 0,
    constraints: Number(r.constraints) || 0,
    pipelines: Number(r.pipelines) || 0,
    active: Number(r.active) || 0,
    deprecated: Number(r.deprecated) || 0,
    total: Number(r.total) || 0,
    updated_at: r.updated_at ?? null,
  }));
}

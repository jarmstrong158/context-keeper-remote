// Entry-level business logic shared by the tools: payload normalization,
// insertion with id-conflict retry, tag handling, and keyword scoring.

import {
  type Entry,
  type EntryRow,
  type Kind,
  type Status,
  getEntry,
  hydrate,
  nextId,
  PREFIX,
} from "./db";

export function nowIso(): string {
  return new Date().toISOString();
}

// Coerce whatever the caller passed for `tags` into a clean string[].
export function normalizeTags(input: unknown): string[] {
  if (input == null) return [];
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [input];
  const out: string[] = [];
  for (const t of raw) {
    const s = String(t).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// Decisions historically used `rationale`; the current convention is
// `why_chosen`. Map the deprecated field forward when the new one is absent.
export function mapRationale(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  if (out.rationale != null && (out.why_chosen == null || out.why_chosen === "")) {
    out.why_chosen = out.rationale;
  }
  delete out.rationale;
  return out;
}

// Build the stored payload for a fresh entry from tool input, per-kind.
export function buildPayload(kind: Kind, input: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...input };
  // Fields that live in dedicated columns, not the payload blob.
  delete payload.project;
  delete payload.status;
  delete payload.id;
  delete payload.kind;
  delete payload.superseded_by;

  if (payload.tags !== undefined) payload.tags = normalizeTags(payload.tags);
  if (kind === "decision") return mapRationale(payload);
  return payload;
}

// Insert a new entry, generating its id. If a concurrent writer grabbed the
// same suffix we get a PK collision, re-derive the id via nextId, and retry.
//
// The steady-state design is two writers (desktop + mobile), for which a single
// retry already suffices. MAX_INSERT_ATTEMPTS gives cheap headroom above that so
// a brief burst of >2 overlapping writes to the same project+kind still resolves
// instead of surfacing a spurious conflict. A short increasing backoff between
// attempts lets the winning writer's row land before we recompute the next id.
const MAX_INSERT_ATTEMPTS = 5;

export async function insertEntry(
  db: D1Database,
  args: { kind: Kind; project: string; status?: Status; payload: Record<string, unknown> },
): Promise<Entry> {
  const status: Status = args.status ?? "active";
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
    if (attempt > 0) await backoff(attempt);
    const id = await nextId(db, args.project, args.kind);
    const now = nowIso();
    try {
      await db
        .prepare(
          `INSERT INTO entries (id, kind, project, status, created_at, updated_at, superseded_by, payload)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(id, args.kind, args.project, status, now, now, JSON.stringify(args.payload))
        .run();
      return {
        id,
        kind: args.kind,
        project: args.project,
        status,
        created_at: now,
        updated_at: now,
        superseded_by: null,
        payload: args.payload,
      };
    } catch (err) {
      lastErr = err;
      // Retry only on a primary-key collision; rethrow anything else.
      if (!isConflict(err)) throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`insert failed after ${MAX_INSERT_ATTEMPTS} attempts`);
}

// Small increasing delay (~2ms, 4ms, …) between id-collision retries so the
// writer that won the previous round can commit before we recompute the id.
function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, attempt * 2));
}

function isConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE|PRIMARY KEY|constraint/i.test(msg);
}

// Insert an entry with a caller-supplied id (used by import_entries). Does not
// overwrite: reports collisions instead.
export async function insertWithId(
  db: D1Database,
  args: {
    id: string;
    kind: Kind;
    project: string;
    status?: Status;
    created_at?: string;
    updated_at?: string;
    superseded_by?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<{ inserted: boolean; reason?: string }> {
  const existing = await db
    .prepare(`SELECT id FROM entries WHERE id = ? AND project = ?`)
    .bind(args.id, args.project)
    .first<{ id: string }>();
  if (existing) return { inserted: false, reason: "id already exists" };

  const now = nowIso();
  try {
    await db
      .prepare(
        `INSERT INTO entries (id, kind, project, status, created_at, updated_at, superseded_by, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        args.id,
        args.kind,
        args.project,
        args.status ?? "active",
        args.created_at ?? now,
        args.updated_at ?? now,
        args.superseded_by ?? null,
        JSON.stringify(args.payload),
      )
      .run();
    return { inserted: true };
  } catch (err) {
    if (isConflict(err)) return { inserted: false, reason: "id already exists" };
    throw err;
  }
}

// Upsert an entry with a caller-supplied id (used by upsert_entries). Unlike
// insertWithId this DOES overwrite, but only when the incoming version is
// strictly newer by `updated_at` (last-writer-wins by timestamp) — so a
// mirror push carries edits and deprecations across without ever clobbering a
// remote change that is itself newer. Never deletes.
//
//   - id absent remotely            -> INSERT           -> "created"
//   - incoming updated_at > existing -> UPDATE (replace) -> "updated"
//   - incoming updated_at <= existing (or missing)       -> "skipped_older"
//
// On "updated" the overwritten (losing) row is returned as `previous` so the
// caller can preserve it for conflict logging.
export async function upsertEntry(
  db: D1Database,
  args: {
    id: string;
    kind: Kind;
    project: string;
    // status is passed through verbatim (may be 'superseded', not just the
    // active/deprecated enum) since the column is free-form TEXT.
    status?: string;
    created_at?: string;
    updated_at?: string;
    superseded_by?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<{ action: "created" | "updated" | "skipped_older"; previous?: Entry }> {
  const existing = await getEntry(db, args.project, args.id);
  const now = nowIso();

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO entries (id, kind, project, status, created_at, updated_at, superseded_by, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        args.id,
        args.kind,
        args.project,
        args.status ?? "active",
        args.created_at ?? now,
        args.updated_at ?? now,
        args.superseded_by ?? null,
        JSON.stringify(args.payload),
      )
      .run();
    return { action: "created" };
  }

  // Exists: replace only if the incoming version is strictly newer. A missing
  // incoming timestamp cannot be proven newer, so it is treated as older.
  const incomingTs = args.updated_at ?? "";
  if (!incomingTs || incomingTs <= existing.updated_at) {
    return { action: "skipped_older" };
  }

  await db
    .prepare(
      `UPDATE entries SET payload = ?, status = ?, superseded_by = ?, updated_at = ?
       WHERE project = ? AND id = ?`,
    )
    .bind(
      JSON.stringify(args.payload),
      args.status ?? existing.status,
      args.superseded_by ?? null,
      incomingTs,
      args.project,
      args.id,
    )
    .run();
  return { action: "updated", previous: existing };
}

// --- text + scoring ---------------------------------------------------------

// Flatten the human-meaningful strings in an entry into one searchable blob.
export function searchableText(entry: Entry): string {
  const parts: string[] = [entry.id, entry.kind];
  collectStrings(entry.payload, parts);
  return parts.join(" \n ").toLowerCase();
}

function collectStrings(value: unknown, out: string[]): void {
  if (value == null) return;
  if (typeof value === "string") {
    out.push(value);
  } else if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

export function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

// Keyword relevance: term-frequency with a small bonus for id/tag hits.
export function scoreEntry(entry: Entry, terms: string[]): number {
  if (terms.length === 0) return 0;
  const text = searchableText(entry);
  const tags = normalizeTags(entry.payload.tags).map((t) => t.toLowerCase());
  let score = 0;
  for (const term of terms) {
    let occurrences = 0;
    let idx = text.indexOf(term);
    while (idx !== -1) {
      occurrences++;
      idx = text.indexOf(term, idx + term.length);
    }
    if (occurrences > 0) {
      score += 1 + Math.log2(occurrences); // diminishing return on repeats
      if (tags.includes(term)) score += 2; // tag match is a strong signal
      if (entry.id.toLowerCase() === term) score += 5; // exact id match wins
    }
  }
  return score;
}

export function hydrateRows(rows: EntryRow[] | undefined): Entry[] {
  return (rows ?? []).map(hydrate);
}

export const KIND_PREFIXES = PREFIX;

import { z } from "zod";
import { defineTool } from "../mcp";
import { type Kind, resolveProject } from "../db";
import { coerceIncomingEntry, upsertEntry } from "../entries";
import { MAX_BATCH_ENTRIES, projectField } from "./common";

// Bulk upsert from the local context-keeper store format. Same input shape as
// import_entries, but instead of skipping every id that already exists it
// carries edits and deprecations across: an existing id is replaced when the
// incoming `updated_at` is strictly newer, and skipped otherwise. This is the
// tool the local mirror pushes through so a deprecation/update on one store
// stops leaving the other showing a stale "active" status. Never deletes —
// deprecation is a status change that upsert carries naturally.
export const upsertEntriesTool = defineTool({
  name: "upsert_entries",
  description:
    "Bulk upsert entries in the local context-keeper JSON store format (a list of objects, each with an `id`). New ids are inserted; an existing id is replaced only when the incoming `updated_at` is strictly newer (last-writer-wins by timestamp), else skipped. Carries edits and deprecations between mirrored stores. Never deletes. Returns per-id action and counts.",
  inputSchema: z.object({
    project: projectField,
    kind: z
      .enum(["decision", "pipeline", "constraint"])
      .describe("Kind of all entries in this batch."),
    // Bounded: this ran unbounded, and every entry is a separate D1 write
    // inside one request. A large enough batch exhausts the Worker's CPU/
    // subrequest budget partway through and leaves the mirror half-applied,
    // which is worse than a clean rejection because the caller has no way to
    // tell which ids landed. Mirrors chunk; 500 is well above a real chunk.
    entries: z
      .array(z.record(z.string(), z.any()))
      .max(MAX_BATCH_ENTRIES)
      .describe(
        "Entry objects in local store format; each needs an `id` and ideally an `updated_at`. " +
          `At most ${MAX_BATCH_ENTRIES} per call — send larger mirrors in chunks.`,
      ),
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const kind = input.kind as Kind;

    const results: Array<{
      id: string;
      action: "created" | "updated" | "skipped_older" | "skipped_no_id" | "error";
      previous?: unknown;
      error?: string;
    }> = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of input.entries) {
      const { id: incomingId, payload, ...cols } = coerceIncomingEntry(kind, raw);
      if (!incomingId) {
        skipped++;
        results.push({ id: "", action: "skipped_no_id" });
        continue;
      }

      try {
        const res = await upsertEntry(db, {
          id: incomingId,
          kind,
          project,
          payload,
          ...cols,
        });
        if (res.action === "created") created++;
        else if (res.action === "updated") updated++;
        else skipped++;
        results.push(
          res.previous
            ? { id: incomingId, action: res.action, previous: res.previous }
            : { id: incomingId, action: res.action },
        );
      } catch (err) {
        skipped++;
        results.push({
          id: incomingId,
          action: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      project,
      kind,
      total: input.entries.length,
      created_count: created,
      updated_count: updated,
      skipped_count: skipped,
      results,
    };
  },
});

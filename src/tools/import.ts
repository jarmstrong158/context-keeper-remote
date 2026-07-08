import { z } from "zod";
import { defineTool } from "../mcp";
import { type Kind, type Status, resolveProject } from "../db";
import { buildPayload, insertEntry, insertWithId } from "../entries";
import { projectField } from "./common";

// Bulk import from the local context-keeper store format: each of
// decisions.json / pipelines.json / constraints.json is a JSON list of entry
// objects carrying an `id`. Ids are preserved; collisions are reported, never
// overwritten.
export const importEntriesTool = defineTool({
  name: "import_entries",
  description:
    "Bulk-insert entries from the local context-keeper JSON store format (a list of objects, each with an `id`). Preserves incoming ids; on id collision it reports rather than overwriting. Migration path from local decisions.json / pipelines.json / constraints.json.",
  inputSchema: z.object({
    project: projectField,
    kind: z
      .enum(["decision", "pipeline", "constraint"])
      .describe("Kind of all entries in this batch."),
    entries: z
      .array(z.record(z.string(), z.any()))
      .describe("Entry objects in local store format."),
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const kind = input.kind as Kind;

    const imported: string[] = [];
    const skipped: Array<{ id?: string; reason: string }> = [];

    for (const raw of input.entries) {
      const incomingId = typeof raw.id === "string" ? raw.id : undefined;
      const status = normalizeStatus(raw.status);
      const payload = buildPayload(kind, raw);

      try {
        if (incomingId) {
          const res = await insertWithId(db, {
            id: incomingId,
            kind,
            project,
            status,
            created_at: typeof raw.created_at === "string" ? raw.created_at : undefined,
            updated_at: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
            superseded_by:
              typeof raw.superseded_by === "string" ? raw.superseded_by : null,
            payload,
          });
          if (res.inserted) imported.push(incomingId);
          else skipped.push({ id: incomingId, reason: res.reason ?? "skipped" });
        } else {
          // No id supplied: allocate a fresh one in sequence.
          const entry = await insertEntry(db, { kind, project, status, payload });
          imported.push(entry.id);
        }
      } catch (err) {
        skipped.push({
          id: incomingId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      project,
      kind,
      total: input.entries.length,
      imported_count: imported.length,
      skipped_count: skipped.length,
      imported,
      skipped,
    };
  },
});

function normalizeStatus(value: unknown): Status | undefined {
  return value === "deprecated" ? "deprecated" : value === "active" ? "active" : undefined;
}

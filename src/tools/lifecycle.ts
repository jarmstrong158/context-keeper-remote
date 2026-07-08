import { z } from "zod";
import { defineTool } from "../mcp";
import { getEntry, listEntries, resolveProject } from "../db";
import { mapRationale, normalizeTags, nowIso } from "../entries";
import { projectField } from "./common";

export const updateEntryTool = defineTool({
  name: "update_entry",
  description:
    "Update an existing entry. Merges `patch` fields into its payload (shallow), and optionally changes status. Bumps updated_at.",
  inputSchema: z.object({
    project: projectField,
    id: z.string().describe("Id of the entry to update."),
    patch: z
      .record(z.string(), z.any())
      .optional()
      .describe("Fields to merge into the entry payload."),
    status: z.enum(["active", "deprecated"]).optional().describe("New status."),
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const entry = await getEntry(db, project, input.id);
    if (!entry) throw new Error(`no entry ${input.id} in project ${project}`);

    let payload: Record<string, unknown> = { ...entry.payload, ...(input.patch ?? {}) };
    if (payload.tags !== undefined) payload.tags = normalizeTags(payload.tags);
    if (entry.kind === "decision") payload = mapRationale(payload);

    const now = nowIso();
    const status = input.status ?? entry.status;
    await db
      .prepare(
        `UPDATE entries SET payload = ?, status = ?, updated_at = ? WHERE project = ? AND id = ?`,
      )
      .bind(JSON.stringify(payload), status, now, project, input.id)
      .run();

    return {
      ok: true,
      id: input.id,
      entry: { ...entry, payload, status, updated_at: now },
    };
  },
});

export const deprecateEntryTool = defineTool({
  name: "deprecate_entry",
  description:
    "Mark an entry deprecated, optionally linking the entry that supersedes it. Deprecated entries are excluded from get_context unless asked for.",
  inputSchema: z.object({
    project: projectField,
    id: z.string().describe("Id of the entry to deprecate."),
    superseded_by: z
      .string()
      .optional()
      .describe("Id of the entry that replaces this one."),
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const entry = await getEntry(db, project, input.id);
    if (!entry) throw new Error(`no entry ${input.id} in project ${project}`);

    let supersededExists: boolean | undefined;
    if (input.superseded_by) {
      supersededExists = !!(await getEntry(db, project, input.superseded_by));
    }

    const now = nowIso();
    await db
      .prepare(
        `UPDATE entries SET status = 'deprecated', superseded_by = ?, updated_at = ? WHERE project = ? AND id = ?`,
      )
      .bind(input.superseded_by ?? null, now, project, input.id)
      .run();

    return {
      ok: true,
      id: input.id,
      status: "deprecated",
      superseded_by: input.superseded_by ?? null,
      ...(input.superseded_by ? { superseded_by_exists: supersededExists } : {}),
    };
  },
});

export const reloadConstraintsTool = defineTool({
  name: "reload_constraints",
  description:
    "Return the active constraints for a project in compact form. Cheap to call at the start of a session to reload the guardrails.",
  inputSchema: z.object({ project: projectField }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const entries = await listEntries(db, project, { kind: "constraint", status: "active" });
    const constraints = entries.map((e) => ({
      id: e.id,
      rule: e.payload.rule ?? e.payload.summary ?? "",
      ...(e.payload.reason ? { reason: e.payload.reason } : {}),
      ...(normalizeTags(e.payload.tags).length
        ? { tags: normalizeTags(e.payload.tags) }
        : {}),
    }));
    return { project, count: constraints.length, constraints };
  },
});

import { z } from "zod";
import { defineTool } from "../mcp";
import { KINDS, type Kind, listEntries, listProjects, resolveProject, getEntry } from "../db";
import { normalizeTags, scoreEntry, searchableText, tokenize } from "../entries";
import { projectField, tagsField } from "./common";

const kindField = z
  .enum(["decision", "pipeline", "constraint"])
  .optional()
  .describe("Restrict to a single kind.");

export const getContextTool = defineTool({
  name: "get_context",
  description:
    "Relevance-ranked retrieval. Returns the entries most relevant to a query via keyword scoring over their fields. Deprecated entries are excluded unless include_deprecated is set.",
  inputSchema: z.object({
    project: projectField,
    query: z.string().describe("What you're looking for; free text."),
    kind: kindField,
    limit: z.number().int().positive().max(50).optional().describe("Max results (default 10)."),
    include_deprecated: z
      .boolean()
      .optional()
      .describe("Include deprecated entries in ranking (default false)."),
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const entries = await listEntries(db, project, {
      kind: input.kind as Kind | undefined,
      includeDeprecated: input.include_deprecated ?? false,
    });
    const terms = tokenize(input.query);
    const limit = input.limit ?? 10;
    const ranked = entries
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => ({ score: Number(r.score.toFixed(3)), ...r.entry }));
    return { project, query: input.query, count: ranked.length, results: ranked };
  },
});

export const queryEntriesTool = defineTool({
  name: "query_entries",
  description:
    "Structured query with combinable filters: id, kind, tags (all must match), status ('active' | 'deprecated' | 'all'), free text (all terms must appear), and limit. Returns matching entries plus `matched` (total before limit).",
  inputSchema: z.object({
    project: projectField,
    id: z.string().optional().describe("Fetch a single entry by id."),
    kind: kindField,
    tags: tagsField.describe("Only entries containing all of these tags."),
    status: z
      .enum(["active", "deprecated", "all"])
      .optional()
      .describe("Status filter. Defaults to 'all'."),
    text: z.string().optional().describe("Free-text: all terms must appear in the entry."),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Max entries to return (default: all matches)."),
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);

    if (input.id) {
      const entry = await getEntry(db, project, input.id);
      return { project, count: entry ? 1 : 0, results: entry ? [entry] : [] };
    }

    const status = input.status ?? "all";
    let entries = await listEntries(db, project, {
      kind: input.kind as Kind | undefined,
      status: status === "all" ? undefined : status,
      includeDeprecated: status === "all",
    });

    const wantTags = normalizeTags(input.tags).map((t) => t.toLowerCase());
    if (wantTags.length) {
      entries = entries.filter((e) => {
        const have = normalizeTags(e.payload.tags).map((t) => t.toLowerCase());
        return wantTags.every((t) => have.includes(t));
      });
    }

    const terms = input.text ? tokenize(input.text) : [];
    if (terms.length) {
      entries = entries.filter((e) => {
        const text = searchableText(e);
        return terms.every((t) => text.includes(t));
      });
    }

    const matched = entries.length;
    if (input.limit != null) entries = entries.slice(0, input.limit);

    return { project, count: entries.length, matched, results: entries };
  },
});

export const getProjectSummaryTool = defineTool({
  name: "get_project_summary",
  description:
    "The single orienting call: the whole lay of the land in one response — entry counts by kind and status, the ids present, the active constraints (compact), and the most recent decisions. Good first call to orient in a project; no further probing needed.",
  inputSchema: z.object({ project: projectField }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const all = await listEntries(db, project, { includeDeprecated: true });

    const byKind: Record<string, { active: number; deprecated: number; ids: string[] }> = {};
    for (const kind of KINDS) byKind[kind] = { active: 0, deprecated: 0, ids: [] };
    for (const e of all) {
      const bucket = byKind[e.kind] ?? (byKind[e.kind] = { active: 0, deprecated: 0, ids: [] });
      bucket.ids.push(e.id);
      if (e.status === "deprecated") bucket.deprecated++;
      else bucket.active++;
    }

    // Additive orientation fields (existing keys above are unchanged): the
    // active constraints in compact form and the most recent decisions, so an
    // agent can orient in one call.
    const activeConstraints = all
      .filter((e) => e.kind === "constraint" && e.status === "active")
      .map((e) => ({ id: e.id, rule: (e.payload.rule as string) ?? "" }));
    const recentDecisions = all
      .filter((e) => e.kind === "decision" && e.status === "active")
      .sort((a, b) =>
        (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at),
      )
      .slice(0, 5)
      .map((e) => ({ id: e.id, summary: (e.payload.summary as string) ?? "" }));

    return {
      project,
      total: all.length,
      active: all.filter((e) => e.status === "active").length,
      deprecated: all.filter((e) => e.status === "deprecated").length,
      by_kind: byKind,
      active_constraints: activeConstraints,
      recent_decisions: recentDecisions,
    };
  },
});

export const listProjectsTool = defineTool({
  name: "list_projects",
  description:
    "The org registry: every project with entries in this store, plus per-project active counts (decisions, constraints, pipelines), active/deprecated totals, and last-updated time. Enumerates the whole org in one call — the reliable way to discover project names (which are case-sensitive) instead of guessing them. Most-recorded first.",
  inputSchema: z.object({}),
  async handler(_input, { db }) {
    const projects = await listProjects(db);
    const totals = projects.reduce(
      (acc, p) => {
        acc.projects += 1;
        acc.decisions += p.decisions;
        acc.constraints += p.constraints;
        acc.pipelines += p.pipelines;
        return acc;
      },
      { projects: 0, decisions: 0, constraints: 0, pipelines: 0 },
    );
    return { count: projects.length, totals, projects };
  },
});

import { z } from "zod";
import { defineTool } from "../mcp";
import { type Entry, type Kind, listEntries, resolveProject } from "../db";
import { normalizeTags } from "../entries";
import { projectField } from "./common";

export const pruneStaleTool = defineTool({
  name: "prune_stale",
  description:
    "Delete deprecated entries older than a cutoff. Defaults to a dry run that only reports what would be removed; pass dry_run=false to actually delete.",
  inputSchema: z.object({
    project: projectField,
    older_than_days: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Only prune deprecated entries not updated in this many days (default 90)."),
    kind: z.enum(["decision", "pipeline", "constraint"]).optional(),
    dry_run: z.boolean().optional().describe("If true (default), report without deleting."),
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const days = input.older_than_days ?? 90;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const dryRun = input.dry_run ?? true;

    const deprecated = await listEntries(db, project, {
      kind: input.kind as Kind | undefined,
      status: "deprecated",
    });
    const stale = deprecated.filter((e) => e.updated_at < cutoff);
    const ids = stale.map((e) => e.id);

    if (!dryRun && ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      await db
        .prepare(`DELETE FROM entries WHERE project = ? AND id IN (${placeholders})`)
        .bind(project, ...ids)
        .run();
    }

    return {
      project,
      cutoff,
      older_than_days: days,
      dry_run: dryRun,
      count: ids.length,
      pruned: dryRun ? [] : ids,
      candidates: ids,
    };
  },
});

// Which payload fields carry the "why" for each kind. Missing = a quality flag.
const RATIONALE_FIELDS: Record<Kind, string[]> = {
  decision: ["why_chosen"],
  constraint: ["reason"],
  pipeline: ["purpose"],
};

function qualityIssues(entry: Entry): string[] {
  const issues: string[] = [];
  const p = entry.payload;
  const has = (f: string) => typeof p[f] === "string" && (p[f] as string).trim().length > 0;

  if (entry.kind === "decision" && !has("summary")) issues.push("missing summary");
  if (entry.kind === "constraint" && !has("rule")) issues.push("missing rule");
  if (entry.kind === "pipeline" && !has("name")) issues.push("missing name");

  for (const field of RATIONALE_FIELDS[entry.kind]) {
    if (!has(field)) issues.push(`missing ${field}`);
  }
  return issues;
}

export const verifyQualityTool = defineTool({
  name: "verify_quality",
  description:
    "Flag active entries that are missing rationale-bearing fields (decision.why_chosen, constraint.reason, pipeline.purpose) or their core field.",
  inputSchema: z.object({
    project: projectField,
    kind: z.enum(["decision", "pipeline", "constraint"]).optional(),
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const entries = await listEntries(db, project, {
      kind: input.kind as Kind | undefined,
      status: "active",
    });
    const flagged = entries
      .map((e) => ({ id: e.id, kind: e.kind, issues: qualityIssues(e) }))
      .filter((r) => r.issues.length > 0);
    return {
      project,
      checked: entries.length,
      flagged_count: flagged.length,
      flagged,
    };
  },
});

// --- markdown export --------------------------------------------------------

function fieldLine(label: string, value: unknown): string | null {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return `- **${label}:** ${value.map((v) => String(v)).join(", ")}`;
  }
  return `- **${label}:** ${String(value)}`;
}

function renderEntry(e: Entry): string {
  const p = e.payload;
  const title = String(p.summary ?? p.rule ?? p.name ?? e.id);
  const lines: string[] = [`### ${e.id} — ${title}`];
  if (e.status !== "active") {
    lines.push(
      `_status: ${e.status}${e.superseded_by ? `, superseded by ${e.superseded_by}` : ""}_`,
    );
  }
  const order =
    e.kind === "decision"
      ? ["problem", "why_chosen", "what_we_tried", "tradeoffs"]
      : e.kind === "constraint"
        ? ["rule", "reason"]
        : ["purpose", "steps"];
  for (const field of order) {
    const line = fieldLine(field, p[field]);
    if (line) lines.push(line);
  }
  const tags = normalizeTags(p.tags);
  if (tags.length) lines.push(`- **tags:** ${tags.join(", ")}`);
  return lines.join("\n");
}

const KIND_HEADINGS: Record<Kind, string> = {
  decision: "Decisions",
  pipeline: "Pipelines",
  constraint: "Constraints",
};

export const exportMarkdownTool = defineTool({
  name: "export_markdown",
  description:
    "Render the project's entries as a DECISIONS.md-style Markdown document. Excludes deprecated entries unless include_deprecated is set.",
  inputSchema: z.object({
    project: projectField,
    kind: z.enum(["decision", "pipeline", "constraint"]).optional(),
    include_deprecated: z.boolean().optional(),
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const entries = await listEntries(db, project, {
      kind: input.kind as Kind | undefined,
      includeDeprecated: input.include_deprecated ?? false,
    });

    const out: string[] = [`# ${project}`, ""];
    const kinds: Kind[] = input.kind
      ? [input.kind as Kind]
      : ["decision", "pipeline", "constraint"];
    for (const kind of kinds) {
      const group = entries.filter((e) => e.kind === kind);
      if (!group.length) continue;
      out.push(`## ${KIND_HEADINGS[kind]}`, "");
      for (const e of group) {
        out.push(renderEntry(e), "");
      }
    }
    const markdown = out.join("\n").trimEnd() + "\n";
    return { project, count: entries.length, markdown };
  },
});

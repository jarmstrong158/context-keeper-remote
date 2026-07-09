import { z } from "zod";
import { defineTool } from "../mcp";
import { type Kind, type Status, resolveProject } from "../db";
import { buildPayload, insertEntry } from "../entries";
import { projectField, statusField, tagsField, textOrList } from "./common";

type RecordInput = { project?: string; status?: Status; [k: string]: unknown };

// Shared write logic: the single source of truth used by record_entry and the
// three deprecated record_* aliases, so behavior and response shape are
// identical no matter which tool a caller uses. buildPayload strips `kind`
// from the stored payload, so passing the full input through is safe.
async function recordOf(db: D1Database, kind: Kind, input: RecordInput) {
  const project = await resolveProject(db, input.project);
  const payload = buildPayload(kind, input as Record<string, unknown>);
  const entry = await insertEntry(db, { kind, project, status: input.status, payload });
  return { ok: true, id: entry.id, entry };
}

// The field each kind requires (mirrors the required fields the three original
// tools enforced via zod). Checked in the record_entry handler because its
// schema is a flat union where these are optional.
const KIND_REQUIRED: Record<Kind, string> = {
  decision: "summary",
  constraint: "rule",
  pipeline: "name",
};

// Unified write tool. Consolidates record_decision / record_constraint /
// record_pipeline (kept below as deprecated aliases). Flat schema so tools/list
// advertises a real object schema; kind-specific required fields are enforced
// in the handler.
export const recordEntryTool = defineTool({
  name: "record_entry",
  description:
    "Unified write tool: record a decision, constraint, or pipeline. Consolidates record_decision / record_constraint / record_pipeline (which remain as deprecated aliases). Required field depends on kind: decision needs summary; constraint needs rule; pipeline needs name.",
  inputSchema: z
    .object({
      kind: z.enum(["decision", "constraint", "pipeline"]).describe("Which kind of entry to record."),
      project: projectField,
      // decision
      summary: z.string().optional().describe("decision: one-line statement of the decision."),
      problem: z.string().optional().describe("decision: the problem being decided."),
      why_chosen: z.string().optional().describe("decision: why this option was chosen."),
      rationale: z.string().optional().describe("decision: deprecated alias for why_chosen."),
      what_we_tried: textOrList.optional().describe("decision: alternatives considered."),
      tradeoffs: textOrList.optional().describe("decision: known downsides accepted."),
      // constraint
      rule: z.string().optional().describe("constraint: the rule that must hold."),
      reason: z.string().optional().describe("constraint: why the constraint exists."),
      // pipeline
      name: z.string().optional().describe("pipeline: pipeline name."),
      purpose: z.string().optional().describe("pipeline: what the pipeline is for."),
      steps: z.array(z.any()).optional().describe("pipeline: ordered steps (strings or objects)."),
      // shared
      tags: tagsField,
      status: statusField,
    })
    .loose(),
  async handler(input, { db }) {
    const kind = input.kind as Kind;
    const required = KIND_REQUIRED[kind];
    const val = (input as Record<string, unknown>)[required];
    if (val == null || val === "") {
      throw new Error(`record_entry kind='${kind}' requires '${required}'.`);
    }
    return recordOf(db, kind, input as RecordInput);
  },
});

export const recordDecisionTool = defineTool({
  name: "record_decision",
  description:
    "Deprecated: use record_entry(kind='decision'). Record a decision: what was chosen and why. Captures the problem, the reasoning, alternatives tried, and tradeoffs so future sessions don't relitigate it.",
  inputSchema: z.object({
    project: projectField,
    summary: z.string().describe("One-line statement of the decision."),
    problem: z.string().optional().describe("The problem or question being decided."),
    why_chosen: z.string().optional().describe("Why this option was chosen."),
    rationale: z
      .string()
      .optional()
      .describe("Deprecated alias for why_chosen; mapped forward when why_chosen is absent."),
    what_we_tried: textOrList.optional().describe("Alternatives considered or attempted."),
    tradeoffs: textOrList.optional().describe("Known downsides accepted."),
    tags: tagsField,
    status: statusField,
  }),
  async handler(input, { db }) {
    return recordOf(db, "decision", input);
  },
});

export const recordConstraintTool = defineTool({
  name: "record_constraint",
  description:
    "Deprecated: use record_entry(kind='constraint'). Record a constraint: a rule that must hold. Use for invariants, hard requirements, and 'never do X' guardrails.",
  inputSchema: z.object({
    project: projectField,
    rule: z.string().describe("The rule that must hold."),
    reason: z.string().optional().describe("Why this constraint exists."),
    tags: tagsField,
    status: statusField,
  }),
  async handler(input, { db }) {
    return recordOf(db, "constraint", input);
  },
});

export const recordPipelineTool = defineTool({
  name: "record_pipeline",
  description:
    "Deprecated: use record_entry(kind='pipeline'). Record a pipeline: a reusable multi-step process or workflow. Captures its name, purpose, and steps.",
  inputSchema: z
    .object({
      project: projectField,
      name: z.string().describe("Pipeline name."),
      purpose: z.string().optional().describe("What the pipeline is for."),
      steps: z
        .array(z.any())
        .optional()
        .describe("Ordered steps (strings or objects), as given."),
      tags: tagsField,
      status: statusField,
    })
    // Schema-flexible: accept extra pipeline fields verbatim.
    .loose(),
  async handler(input, { db }) {
    return recordOf(db, "pipeline", input as RecordInput);
  },
});

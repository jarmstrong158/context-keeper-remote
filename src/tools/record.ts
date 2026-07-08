import { z } from "zod";
import { defineTool } from "../mcp";
import { resolveProject } from "../db";
import { buildPayload, insertEntry } from "../entries";
import { projectField, statusField, tagsField, textOrList } from "./common";

export const recordDecisionTool = defineTool({
  name: "record_decision",
  description:
    "Record a decision: what was chosen and why. Captures the problem, the reasoning, alternatives tried, and tradeoffs so future sessions don't relitigate it.",
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
    const project = await resolveProject(db, input.project);
    const payload = buildPayload("decision", input as Record<string, unknown>);
    const entry = await insertEntry(db, {
      kind: "decision",
      project,
      status: input.status,
      payload,
    });
    return { ok: true, id: entry.id, entry };
  },
});

export const recordConstraintTool = defineTool({
  name: "record_constraint",
  description:
    "Record a constraint: a rule that must hold. Use for invariants, hard requirements, and 'never do X' guardrails.",
  inputSchema: z.object({
    project: projectField,
    rule: z.string().describe("The rule that must hold."),
    reason: z.string().optional().describe("Why this constraint exists."),
    tags: tagsField,
    status: statusField,
  }),
  async handler(input, { db }) {
    const project = await resolveProject(db, input.project);
    const payload = buildPayload("constraint", input as Record<string, unknown>);
    const entry = await insertEntry(db, {
      kind: "constraint",
      project,
      status: input.status,
      payload,
    });
    return { ok: true, id: entry.id, entry };
  },
});

export const recordPipelineTool = defineTool({
  name: "record_pipeline",
  description:
    "Record a pipeline: a reusable multi-step process or workflow. Captures its name, purpose, and steps.",
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
    const project = await resolveProject(db, input.project);
    const payload = buildPayload("pipeline", input as Record<string, unknown>);
    const entry = await insertEntry(db, {
      kind: "pipeline",
      project,
      status: input.status as "active" | "deprecated" | undefined,
      payload,
    });
    return { ok: true, id: entry.id, entry };
  },
});

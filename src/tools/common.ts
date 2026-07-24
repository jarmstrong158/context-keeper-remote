// Shared zod fragments for tool input schemas.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Size and cardinality limits.
//
// These tools write to a D1 database on behalf of whoever holds the path token,
// and until now nothing bounded how much. `upsert_entries` accepted an
// unbounded array, the record tools were `.loose()` with no length bound on any
// field, and every entry written is read back by get_context/query_entries and
// rendered into a model's context window. An unbounded write is therefore both
// a storage problem and a context-pollution problem, and neither surfaces as an
// error -- the write just succeeds and the store quietly degrades.
//
// The numbers are chosen to be far above any legitimate use (a decision's
// rationale is paragraphs, not megabytes) and far below anything that hurts.
// ---------------------------------------------------------------------------

/** Longest free-text field (summary, rationale, rule, ...). */
export const MAX_TEXT_LENGTH = 20_000;
/** Longest short identifier-ish field (project, tag, name). */
export const MAX_NAME_LENGTH = 200;
/** Most items in a list-valued text field (what_we_tried, tradeoffs, steps). */
export const MAX_LIST_ITEMS = 100;
/** Most tags on one entry. */
export const MAX_TAGS = 50;
/** Most entries in a single bulk import/upsert batch. */
export const MAX_BATCH_ENTRIES = 500;

// `project` is optional everywhere; it falls back to config default_project.
export const projectField = z
  .string()
  .max(MAX_NAME_LENGTH)
  .optional()
  .describe("Project name. Falls back to the configured default_project if omitted.");

export const tagsField = z
  .union([
    z.string().max(MAX_TEXT_LENGTH),
    z.array(z.string().max(MAX_NAME_LENGTH)).max(MAX_TAGS),
  ])
  .optional()
  .describe("Tags as an array of strings, or a comma-separated string.");

// Free-form text field that tolerates a single string or a list.
export const textOrList = z.union([
  z.string().max(MAX_TEXT_LENGTH),
  z.array(z.string().max(MAX_TEXT_LENGTH)).max(MAX_LIST_ITEMS),
]);

/** A bounded free-text field. */
export const textField = z.string().max(MAX_TEXT_LENGTH);

export const statusField = z
  .enum(["active", "deprecated"])
  .optional()
  .describe("Entry status. Defaults to 'active'.");

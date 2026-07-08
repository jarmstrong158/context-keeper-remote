// Shared zod fragments for tool input schemas.
import { z } from "zod";

// `project` is optional everywhere; it falls back to config default_project.
export const projectField = z
  .string()
  .optional()
  .describe("Project name. Falls back to the configured default_project if omitted.");

export const tagsField = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("Tags as an array of strings, or a comma-separated string.");

// Free-form text field that tolerates a single string or a list.
export const textOrList = z.union([z.string(), z.array(z.string())]);

export const statusField = z
  .enum(["active", "deprecated"])
  .optional()
  .describe("Entry status. Defaults to 'active'.");

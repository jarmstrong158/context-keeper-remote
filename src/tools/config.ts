import { z } from "zod";
import { defineTool } from "../mcp";
import { GLOBAL_SCOPE, getConfig, setConfig } from "../db";
import { projectField } from "./common";

// Shared logic, the single source of truth for reads/writes. The unified
// `config` tool and the deprecated get_config / set_config aliases all route
// through these, so every surface returns the exact same shape.
async function opGet(db: D1Database, key: string, project?: string) {
  const scope = project?.trim() || GLOBAL_SCOPE;
  const value = await getConfig(db, key, scope);
  return { key, value, scope: scope || "(global)" };
}

async function opSet(db: D1Database, key: string, value: string, project?: string) {
  const scope = project?.trim() || GLOBAL_SCOPE;
  await setConfig(db, key, value, scope);
  return { ok: true, key, value, scope: scope || "(global)" };
}

// Unified config tool: op='get' reads, op='set' writes. Consolidates the two
// original tools (kept below as deprecated aliases) so new config operations
// don't each need a new tool.
export const configTool = defineTool({
  name: "config",
  description:
    "Read or write a config value. op='get' reads a key; op='set' writes it (value required). Use key 'default_project' (global scope, no project) to pick the project used when a tool call omits `project`.",
  inputSchema: z.object({
    op: z.enum(["get", "set"]).describe("'get' to read a key, 'set' to write it."),
    key: z.string().describe("Config key, e.g. 'default_project'."),
    value: z
      .string()
      .optional()
      .describe("Value to write. Required when op='set'; ignored for op='get'."),
    project: projectField.describe(
      "Optional project scope. Omit for global config such as default_project.",
    ),
  }),
  async handler(input, { db }) {
    if (input.op === "set") {
      if (input.value === undefined) {
        throw new Error("config op='set' requires `value`.");
      }
      return opSet(db, input.key, input.value, input.project);
    }
    return opGet(db, input.key, input.project);
  },
});

// Deprecated alias for config(op='set'). Kept so existing callers of set_config
// keep working unchanged — identical input schema and response shape.
export const setConfigTool = defineTool({
  name: "set_config",
  description:
    "Deprecated: use config(op='set'). Set a config value. Use key 'default_project' (global scope, no project) to pick the project used when a tool call omits `project`.",
  inputSchema: z.object({
    key: z.string().describe("Config key, e.g. 'default_project'."),
    value: z.string().describe("Config value."),
    project: projectField.describe(
      "Optional project scope. Omit for global config such as default_project.",
    ),
  }),
  async handler(input, { db }) {
    return opSet(db, input.key, input.value, input.project);
  },
});

// Deprecated alias for config(op='get').
export const getConfigTool = defineTool({
  name: "get_config",
  description: "Deprecated: use config(op='get'). Read a config value (global scope unless a project is given).",
  inputSchema: z.object({
    key: z.string(),
    project: projectField,
  }),
  async handler(input, { db }) {
    return opGet(db, input.key, input.project);
  },
});

import { z } from "zod";
import { defineTool } from "../mcp";
import { GLOBAL_SCOPE, getConfig, setConfig } from "../db";
import { projectField } from "./common";

// Set a config value. Global scope (project omitted) is where default_project
// lives; a project can also be passed to scope config to that project.
export const setConfigTool = defineTool({
  name: "set_config",
  description:
    "Set a config value. Use key 'default_project' (global scope, no project) to pick the project used when a tool call omits `project`.",
  inputSchema: z.object({
    key: z.string().describe("Config key, e.g. 'default_project'."),
    value: z.string().describe("Config value."),
    project: projectField.describe(
      "Optional project scope. Omit for global config such as default_project.",
    ),
  }),
  async handler(input, { db }) {
    const scope = input.project?.trim() || GLOBAL_SCOPE;
    await setConfig(db, input.key, input.value, scope);
    return {
      ok: true,
      key: input.key,
      value: input.value,
      scope: scope || "(global)",
    };
  },
});

export const getConfigTool = defineTool({
  name: "get_config",
  description: "Read a config value (global scope unless a project is given).",
  inputSchema: z.object({
    key: z.string(),
    project: projectField,
  }),
  async handler(input, { db }) {
    const scope = input.project?.trim() || GLOBAL_SCOPE;
    const value = await getConfig(db, input.key, scope);
    return { key: input.key, value, scope: scope || "(global)" };
  },
});

import type { ToolDef } from "../mcp";
import { configTool, getConfigTool, setConfigTool } from "./config";
import {
  recordConstraintTool,
  recordDecisionTool,
  recordEntryTool,
  recordPipelineTool,
} from "./record";
import {
  getContextTool,
  getProjectSummaryTool,
  listProjectsTool,
  queryEntriesTool,
} from "./retrieve";
import { deprecateEntryTool, reloadConstraintsTool, updateEntryTool } from "./lifecycle";
import { exportMarkdownTool, pruneStaleTool, verifyQualityTool } from "./maintenance";
import { importEntriesTool } from "./import";
import { upsertEntriesTool } from "./upsert";

// Every tool the server exposes, in a stable order.
export const ALL_TOOLS: ToolDef[] = [
  // config
  configTool,
  setConfigTool,
  getConfigTool,
  // core
  recordEntryTool,
  recordDecisionTool,
  recordConstraintTool,
  recordPipelineTool,
  getContextTool,
  queryEntriesTool,
  getProjectSummaryTool,
  listProjectsTool,
  // lifecycle
  updateEntryTool,
  deprecateEntryTool,
  reloadConstraintsTool,
  // maintenance
  pruneStaleTool,
  verifyQualityTool,
  exportMarkdownTool,
  // remote-only
  importEntriesTool,
  upsertEntriesTool,
];

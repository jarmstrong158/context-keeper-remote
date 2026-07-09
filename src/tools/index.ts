import type { ToolDef } from "../mcp";
import { configTool, getConfigTool, setConfigTool } from "./config";
import { recordConstraintTool, recordDecisionTool, recordPipelineTool } from "./record";
import { getContextTool, getProjectSummaryTool, queryEntriesTool } from "./retrieve";
import { deprecateEntryTool, reloadConstraintsTool, updateEntryTool } from "./lifecycle";
import { exportMarkdownTool, pruneStaleTool, verifyQualityTool } from "./maintenance";
import { importEntriesTool } from "./import";

// Every tool the server exposes, in a stable order.
export const ALL_TOOLS: ToolDef[] = [
  // config
  configTool,
  setConfigTool,
  getConfigTool,
  // core
  recordDecisionTool,
  recordConstraintTool,
  recordPipelineTool,
  getContextTool,
  queryEntriesTool,
  getProjectSummaryTool,
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
];

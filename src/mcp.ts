// Minimal, stateless MCP server over Streamable HTTP.
//
// Why hand-rolled instead of McpAgent: the tools here are stateless RPCs
// against D1, so there is no session to keep in a Durable Object. A plain
// request->response handler keeps the Worker on the free plan (no DO) and is
// trivially testable in workerd with no network. `createMcpHandler` below is
// the stateless handler factory the design calls for.

import { z } from "zod";
import { log } from "./log";
import {
  DEFAULT_PROTOCOL_VERSION,
  type JsonRpcMessage,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  handleJsonRpcHttp,
  isNotification,
  negotiateProtocol,
  rpcError,
  rpcResult,
} from "./shared/mcp-core";

export const PROTOCOL_VERSION = DEFAULT_PROTOCOL_VERSION;

export interface ToolContext {
  db: D1Database;
  env: Env;
  // Lazily ensure the D1 schema exists before a tool runs. Kept OFF the
  // initialize/ping/tools-list path so the handshake never blocks on D1;
  // invoked by callTool only. Optional so unit tests can omit it.
  ready?: () => Promise<void>;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown;
}

// Identity helper that preserves the schema's inferred input type.
export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

interface RegisteredTool {
  def: ToolDef;
  jsonSchema: Record<string, unknown>;
}

export class McpServer {
  private tools = new Map<string, RegisteredTool>();

  constructor(public info: { name: string; version: string }) {}

  register(def: ToolDef): void {
    this.tools.set(def.name, { def, jsonSchema: toInputJsonSchema(def.inputSchema) });
  }

  registerAll(defs: ToolDef[]): void {
    for (const d of defs) this.register(d);
  }

  list(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.tools.values()].map((t) => ({
      name: t.def.name,
      description: t.def.description,
      inputSchema: t.jsonSchema,
    }));
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
}

function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  } catch {
    json = { type: "object" };
  }
  delete (json as Record<string, unknown>).$schema;
  // MCP tool input schemas must be object schemas.
  if (json.type !== "object") json = { type: "object", properties: {} };
  if (!("properties" in json)) json.properties = {};
  return json;
}

// --- JSON-RPC plumbing ------------------------------------------------------
//
// The envelope (batching, notification handling, parse errors, size caps) lives
// in src/shared/mcp-core.ts and is shared byte-identically with
// agentsync-remote and cambium-remote. Only the MCP method semantics below are
// repo-specific.

// A single JSON-RPC message -> a response object, or null for notifications.
async function dispatch(
  server: McpServer,
  msg: JsonRpcMessage,
  ctx: ToolContext,
): Promise<object | null> {
  const id = msg.id ?? null;
  const notification = isNotification(msg);
  const method = msg.method;

  if (!method) {
    return notification ? null : rpcError(id, RPC_INVALID_REQUEST, "missing method");
  }

  switch (method) {
    case "initialize": {
      // Never echo an unrecognized version back: a client asking for "banana"
      // negotiates down to our pinned revision rather than dictating it.
      const { version, requested } = negotiateProtocol(
        (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion,
      );
      // Pure protocol, no I/O -> answers instantly on a cold isolate.
      log("handshake", { phase: "start", protocol_version: version, requested });
      const res = rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: server.info,
      });
      log("handshake", { phase: "complete", protocol_version: version });
      return res;
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: server.list() });
    case "tools/call":
      return callTool(server, id, msg.params, ctx);
    default:
      // Notifications like notifications/initialized are acknowledged silently.
      if (notification) return null;
      return rpcError(id, RPC_METHOD_NOT_FOUND, `unknown method: ${method}`);
  }
}

async function callTool(
  server: McpServer,
  id: string | number | null,
  params: unknown,
  ctx: ToolContext,
): Promise<object> {
  const { name, arguments: args } = (params ?? {}) as {
    name?: string;
    arguments?: unknown;
  };
  if (!name) return rpcError(id, RPC_INVALID_PARAMS, "missing tool name");

  const tool = server.get(name);
  if (!tool) return rpcError(id, RPC_METHOD_NOT_FOUND, `unknown tool: ${name}`);

  const parsed = tool.def.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return rpcError(
      id,
      RPC_INVALID_PARAMS,
      `invalid arguments for ${name}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const started = Date.now();
  try {
    // Ensure the schema exists on the first tool call of a cold isolate. Inside
    // the try so a migration failure is reported as an isError tool result
    // rather than crashing the request.
    if (ctx.ready) await ctx.ready();
    const result = await tool.def.handler(parsed.data, ctx);
    log("tool_call", { tool: name, duration_ms: Date.now() - started, ok: true });
    return rpcResult(id, {
      content: [{ type: "text", text: stringify(result) }],
      structuredContent: wrapStructured(result),
      isError: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("tool_call", { tool: name, duration_ms: Date.now() - started, ok: false });
    log("error", { message, stack: err instanceof Error ? err.stack : undefined });
    return rpcResult(id, {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    });
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

// structuredContent must be a JSON object; wrap primitives/arrays.
function wrapStructured(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

// The stateless handler factory. Returns a function that turns one POST body
// into one HTTP response, per Streamable HTTP. The envelope itself (batching,
// 202-for-notifications, parse errors, body-size and batch-cardinality caps) is
// the shared implementation; only `dispatch` is repo-specific.
export function createMcpHandler(server: McpServer) {
  return async function handle(request: Request, ctx: ToolContext): Promise<Response> {
    return handleJsonRpcHttp(request, (msg) => dispatch(server, msg, ctx), {
      onError: (err) =>
        log("error", {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }),
    });
  };
}

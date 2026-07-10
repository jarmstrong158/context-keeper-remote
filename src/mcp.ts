// Minimal, stateless MCP server over Streamable HTTP.
//
// Why hand-rolled instead of McpAgent: the tools here are stateless RPCs
// against D1, so there is no session to keep in a Durable Object. A plain
// request->response handler keeps the Worker on the free plan (no DO) and is
// trivially testable in workerd with no network. `createMcpHandler` below is
// the stateless handler factory the design calls for.

import { z } from "zod";
import { log } from "./log";

export const PROTOCOL_VERSION = "2025-06-18";
// Protocol versions we will echo back if a client asks for them.
const SUPPORTED_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

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

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const enum RpcError {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

// A single JSON-RPC message -> a response object, or null for notifications.
async function dispatch(
  server: McpServer,
  msg: JsonRpcRequest,
  ctx: ToolContext,
): Promise<object | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || msg.id === null;
  const method = msg.method;

  if (!method) {
    return isNotification ? null : rpcError(id, RpcError.InvalidRequest, "missing method");
  }

  switch (method) {
    case "initialize": {
      const requested =
        (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion;
      const protocolVersion =
        requested && SUPPORTED_PROTOCOLS.has(requested) ? requested : PROTOCOL_VERSION;
      // Pure protocol, no I/O -> answers instantly on a cold isolate.
      log("handshake", { phase: "start", protocol_version: protocolVersion, requested: requested ?? null });
      const res = rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: server.info,
      });
      log("handshake", { phase: "complete", protocol_version: protocolVersion });
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
      if (isNotification || method.startsWith("notifications/")) return null;
      return rpcError(id, RpcError.MethodNotFound, `unknown method: ${method}`);
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
  if (!name) return rpcError(id, RpcError.InvalidParams, "missing tool name");

  const tool = server.get(name);
  if (!tool) return rpcError(id, RpcError.MethodNotFound, `unknown tool: ${name}`);

  const parsed = tool.def.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return rpcError(
      id,
      RpcError.InvalidParams,
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

const JSON_HEADERS = { "content-type": "application/json" } as const;

// The stateless handler factory. Returns a function that turns one POST body
// into one HTTP response, per Streamable HTTP.
export function createMcpHandler(server: McpServer) {
  return async function handle(request: Request, ctx: ToolContext): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(rpcError(null, RpcError.ParseError, "invalid JSON"), {
        headers: JSON_HEADERS,
      });
    }

    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as JsonRpcRequest[];

    const responses: object[] = [];
    for (const msg of messages) {
      let res: object | null;
      try {
        res = await dispatch(server, msg, ctx);
      } catch (err) {
        // A single bad message must never take down the batch or bubble a 500.
        log("error", {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        const id = (msg as JsonRpcRequest)?.id ?? null;
        res = rpcError(id, RpcError.InternalError, "internal error");
      }
      if (res) responses.push(res);
    }

    // Only notifications -> nothing to return.
    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }

    const payload = batch ? responses : responses[0];
    return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
  };
}

import { SELF } from "cloudflare:test";

export const TOKEN = "test-secret-token";
const ORIGIN = "https://worker.example.com";

let idCounter = 0;

// POST a single JSON-RPC message to the worker at /mcp/:token.
export async function rpc(
  method: string,
  params?: unknown,
  token: string = TOKEN,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/mcp/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++idCounter, method, params }),
  });
}

// Parsed JSON-RPC envelope for a method call.
export async function rpcJson(
  method: string,
  params?: unknown,
  token: string = TOKEN,
): Promise<{ status: number; body: any }> {
  const res = await rpc(method, params, token);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Call a tool and return its structured result, throwing on protocol or tool error.
export async function callTool(name: string, args?: unknown): Promise<any> {
  const { body } = await rpcJson("tools/call", { name, arguments: args ?? {} });
  if (body.error) throw new Error(`rpc error: ${body.error.message}`);
  if (body.result?.isError) {
    throw new Error(body.result.content?.[0]?.text ?? "tool error");
  }
  return body.result.structuredContent;
}

// Raw tool call that returns the full result (for asserting isError).
export async function callToolRaw(name: string, args?: unknown): Promise<any> {
  const { body } = await rpcJson("tools/call", { name, arguments: args ?? {} });
  return body;
}

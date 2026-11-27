/**
 * ReadFlow Remote MCP Endpoint（P61，Streamable HTTP + JSON-RPC 2.0）。
 *
 * 鉴权：Authorization: Bearer rfm_...（或 x-readflow-mcp-token），严格按 user.id 隔离。
 */
import { NextResponse } from "next/server";
import { extractMcpToken, userFromMcpToken } from "@/lib/mcp-tokens";
import { handleMcpMessage, type JsonRpcResponse } from "@/lib/mcp/protocol";
import { executeMcpTool } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveOrigin(req: Request): string | null {
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) {
    const scheme = proto?.split(",")[0]?.trim() || "https";
    return `${scheme}://${host}`;
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const token = extractMcpToken(req.headers);
  const user = userFromMcpToken(token);
  if (!user) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Unauthorized: 缺少或无效的 MCP Token" },
      },
      {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="ReadFlow MCP"' },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: 请求体不是合法 JSON" },
      },
      { status: 400 },
    );
  }

  const origin = resolveOrigin(req);
  const executor = (name: string, args: Record<string, unknown>) =>
    executeMcpTool(user.id, origin, name, args);

  if (Array.isArray(body)) {
    if (body.length === 0) {
      return NextResponse.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
        { status: 400 },
      );
    }
    const results: JsonRpcResponse[] = [];
    for (const item of body) {
      const res = await handleMcpMessage(item, executor);
      if (res) results.push(res);
    }
    if (results.length === 0) {
      return new NextResponse(null, { status: 202 });
    }
    return NextResponse.json(results);
  }

  const res = await handleMcpMessage(body, executor);
  if (res === null) {
    return new NextResponse(null, { status: 202 });
  }
  return NextResponse.json(res);
}

/** 无状态 Streamable HTTP：不维持服务端 SSE 通道，按 MCP 规范返回 405 */
export async function GET() {
  return NextResponse.json(
    { error: "ReadFlow MCP 使用无状态 POST JSON-RPC 2.0，不开启长连接 SSE" },
    { status: 405, headers: { Allow: "POST, DELETE" } },
  );
}

export async function DELETE() {
  return new NextResponse(null, { status: 204 });
}

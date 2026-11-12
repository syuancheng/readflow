import { NextResponse } from "next/server";
import { lookup } from "@/lib/dict";
import { extensionError, preflight, requireExtensionUser, withCors } from "@/lib/extension-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return preflight();
}

/**
 * GET /api/extension/dict?word=...
 * 插件划词查词。与 /api/dict 同一个词典，区别只在鉴权：插件不带登录 cookie，凭 Token 认人。
 */
export async function GET(req: Request) {
  const auth = requireExtensionUser(req);
  if ("response" in auth) return auth.response;
  const word = new URL(req.url).searchParams.get("word")?.trim();
  if (!word || word.length > 120) return extensionError("缺少要查的词", 400);
  try {
    return withCors(NextResponse.json(lookup(word)));
  } catch (err) {
    // ECDICT 未导入等情况：插件照样能走 AI 释义
    const msg = err instanceof Error ? err.message : "lookup failed";
    return withCors(NextResponse.json({ error: msg, entry: null }, { status: 500 }));
  }
}

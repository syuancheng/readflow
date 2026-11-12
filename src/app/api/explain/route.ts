import { NextRequest } from "next/server";
import type { ExplainParams } from "@/lib/ai";
import { currentUser } from "@/lib/auth";
import { explainParamsFromBody, handleExplain } from "@/lib/explain-handler";

export const dynamic = "force-dynamic";

/**
 * AI 释义接口（流式）
 *
 * GET  /api/explain?word=...&context=...（兼容旧调用，只带一句话上下文，不带 signals）
 * POST /api/explain  body: { word, prefix?, suffix?, language?, monolingual?, prompt?, signals? }
 *   —— 段落级上下文 + 阅读器采集的客观信号（选中/前文/后文/观察分开标注）
 *
 * - 流式输出（SSE）
 * - 支持 monolingual（目标语言解释）
 * - 支持 prompt（用户自由追问，对应 Readlang 的 askAI）；与默认释义共用同一套 system
 * - signals 只含客观证据、不含结论；判断句法权重与答案深度交给模型
 *
 * 返回 text/event-stream，每个 chunk 是纯文本。
 */

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  const params = req.nextUrl.searchParams;
  const word = params.get("word")?.trim();
  const context = params.get("context")?.trim() ?? "";
  const language = params.get("language") ?? "en";
  const monolingual = params.get("monolingual") === "true";
  const prompt = params.get("prompt")?.trim() || undefined;
  const prefix = params.get("prefix")?.trim() || undefined;
  const suffix = params.get("suffix")?.trim() || undefined;

  if (!word) {
    return Response.json({ error: "word is required" }, { status: 400 });
  }

  return handleExplain({ word, context, language, monolingual, prompt, prefix, suffix }, user);
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  let body: Partial<ExplainParams> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const params = explainParamsFromBody(body);
  if (!params) {
    return Response.json({ error: "word is required" }, { status: 400 });
  }
  return handleExplain(params, user);
}

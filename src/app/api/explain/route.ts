import { NextRequest } from "next/server";
import { streamExplain, type ExplainParams } from "@/lib/ai";

export const dynamic = "force-dynamic";

/**
 * AI 释义接口（流式）
 *
 * GET  /api/explain?word=...&context=...（兼容旧调用，只带一句话上下文）
 * POST /api/explain  body: { word, prefix?, suffix?, language?, monolingual?, prompt? }
 *   —— 新版：段落级上下文，选区/前文/后文分开标注（对齐 Readlang Explain）
 *
 * - 流式输出（SSE）
 * - 支持 monolingual（目标语言解释）
 * - 支持 prompt（用户自由追问，对应 Readlang 的 askAI）
 *
 * 返回 text/event-stream，每个 chunk 是纯文本。
 */

async function handle(params: ExplainParams) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamExplain(params)) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "AI explain failed";
        controller.enqueue(encoder.encode(`\n\n[Error: ${msg}]`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function GET(req: NextRequest) {
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

  return handle({ word, context, language, monolingual, prompt, prefix, suffix });
}

export async function POST(req: NextRequest) {
  let body: Partial<ExplainParams> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const word = typeof body.word === "string" ? body.word.trim() : "";
  if (!word) {
    return Response.json({ error: "word is required" }, { status: 400 });
  }

  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  return handle({
    word,
    context: str(body.context) ?? "",
    prefix: str(body.prefix),
    suffix: str(body.suffix),
    language: str(body.language) ?? "en",
    monolingual: body.monolingual === true,
    prompt: str(body.prompt)?.trim() || undefined,
  });
}

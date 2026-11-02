import { NextRequest } from "next/server";
import { streamExplain } from "@/lib/ai";

export const dynamic = "force-dynamic";

/**
 * AI 释义接口（流式）
 * GET /api/explain?word=plu&context=il+a+plu+toute+la+nuit&language=en&monolingual=false&prompt=...
 *
 * 对齐 Readlang 的 GET /api/smartDictionary:
 * - 流式输出（SSE）
 * - 带 context（整句话）
 * - 支持 monolingual（目标语言解释）
 * - 支持 prompt（用户自由追问，对应 Readlang 的 askAI）
 *
 * 返回 text/event-stream，每个 chunk 是纯文本。
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const word = params.get("word")?.trim();
  const context = params.get("context")?.trim() ?? "";
  const language = params.get("language") ?? "en";
  const monolingual = params.get("monolingual") === "true";
  const prompt = params.get("prompt")?.trim() || undefined;

  if (!word) {
    return Response.json({ error: "word is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamExplain({ word, context, language, monolingual, prompt })) {
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

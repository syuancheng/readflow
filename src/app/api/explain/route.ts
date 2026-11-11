import { NextRequest } from "next/server";
import { streamExplain, type ExplainParams } from "@/lib/ai";
import { currentUser, type AuthUser } from "@/lib/auth";
import { aiContextFor } from "@/lib/user-secrets";
import { consumeAiQuota, quotaExceededMessage } from "@/lib/ai-quota";
import type { SelectionSignals } from "@/lib/sentence";

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

const clamp = (v: unknown, lo: number, hi: number): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(lo, Math.min(hi, v));
};

/** 白名单提取 + 数值裁剪：signals 来自客户端，不能直接信任 */
function narrowSignals(v: unknown): SelectionSignals | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const source = o.source === "word" || o.source === "select" ? o.source : undefined;
  const position =
    o.position === "start" || o.position === "middle" || o.position === "end"
      ? o.position
      : undefined;
  if (!source || !position) return undefined;

  const repeat = clamp(o.repeatCount, 0, 99);

  // priorAsks：同句历史，只存选区文本（截断防滥用），不含 AI 生成内容
  let priorAsks: { selection: string }[] | undefined;
  if (Array.isArray(o.priorAsks)) {
    const cleaned = o.priorAsks
      .filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null &&
        typeof (item as Record<string, unknown>).selection === "string",
      )
      .map((item) => ({
        selection: String((item as Record<string, unknown>).selection).slice(0, 500),
      }))
      .slice(0, 20);
    if (cleaned.length > 0) priorAsks = cleaned;
  }

  return {
    source,
    position,
    selectionWords: clamp(o.selectionWords, 0, 10000) ?? 0,
    sentenceWords: clamp(o.sentenceWords, 0, 10000) ?? 0,
    coverage: clamp(o.coverage, 0, 1) ?? 0,
    sentence: typeof o.sentence === "string" ? o.sentence.slice(0, 2000) : "",
    sentenceStart: clamp(o.sentenceStart, 0, 10_000_000) ?? 0,
    sentenceEnd: clamp(o.sentenceEnd, 0, 10_000_000) ?? 0,
    ...(typeof o.dictHit === "boolean" ? { dictHit: o.dictHit } : {}),
    ...(repeat !== undefined ? { repeatCount: repeat } : {}),
    ...(priorAsks ? { priorAsks } : {}),
  };
}

async function handle(params: ExplainParams, user: AuthUser) {
  // P28：按账号选模型配置；普通账号用站点 Key 时扣每日免费次数
  const ai = aiContextFor(user);
  if (ai.metered) {
    const q = consumeAiQuota(user.id);
    if (!q.ok) return Response.json({ error: quotaExceededMessage(q.limit), quota: q }, { status: 429 });
  }
  const encoder = new TextEncoder();
  const iter = streamExplain(params, ai)[Symbol.asyncIterator]();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (!cancelled) {
          const { value, done } = await iter.next();
          if (done || cancelled) break;
          controller.enqueue(encoder.encode(value));
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "AI explain failed";
          controller.enqueue(encoder.encode(`\n\n[Error: ${msg}]`));
        }
      } finally {
        if (!cancelled) controller.close();
      }
    },
    // 前端切到别的词会 abort 请求：顺着 return() 关掉上游模型流，别继续烧 token
    cancel() {
      cancelled = true;
      void iter.return?.(undefined);
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

  return handle({ word, context, language, monolingual, prompt, prefix, suffix }, user);
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
    withPrevSentence: body.withPrevSentence === true,
    signals: narrowSignals(body.signals),
  }, user);
}

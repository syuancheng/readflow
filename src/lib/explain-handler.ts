/**
 * AI 释义的共用处理（/api/explain 与插件的 /api/extension/explain 共用）。
 * 路由文件只能导出 GET/POST 等固定名字，所以放在这里。
 */
import { streamExplain, type ExplainParams } from "@/lib/ai";
import type { AuthUser } from "@/lib/auth";
import { aiContextFor } from "@/lib/user-secrets";
import { consumeAiQuota, quotaExceededMessage } from "@/lib/ai-quota";
import type { SelectionSignals } from "@/lib/sentence";
import { learnerBlockFor, logExplain } from "@/lib/learner-store";
import { narrowAskKind } from "@/lib/learner/ask-kind";

const clamp = (v: unknown, lo: number, hi: number): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(lo, Math.min(hi, v));
};

/** 白名单提取 + 数值裁剪：signals 来自客户端，不能直接信任 */
export function narrowSignals(v: unknown): SelectionSignals | undefined {
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

export async function handleExplain(
  params: ExplainParams,
  user: AuthUser,
  opts?: { via?: "reader" | "extension" },
) {
  // P28：按账号选模型配置；普通账号用站点 Key 时扣每日免费次数
  const ai = aiContextFor(user);
  if (ai.metered) {
    const q = consumeAiQuota(user.id);
    if (!q.ok) return Response.json({ error: quotaExceededMessage(q.limit), quota: q }, { status: 429 });
  }

  // P32 F4：画像只在这一处接入，网站与插件自动一致。开关关闭时 block 为空串、
  // personalized 为 false，提示词逐字回到旧规则。
  let profile = { block: "", detailed: false, personalized: false };
  try {
    profile = learnerBlockFor(user.id);
  } catch (err) {
    console.error("[learner] 读取档案失败，本次按旧规则讲解:", err);
  }

  // 事件 id 同时是「这段回答」的 id；记事件失败绝不能打断讲解
  let answerId = "";
  try {
    answerId = logExplain({
      userId: user.id,
      askKind: narrowAskKind(params.askKind),
      via: opts?.via ?? "reader",
      word: params.word,
      contextId: params.contextId,
      textId: params.textId,
      dictHit: params.signals?.dictHit,
      repeatCount: params.signals?.repeatCount,
    });
  } catch (err) {
    console.error("[learner] 记录讲解事件失败:", err);
  }

  const enriched: ExplainParams = {
    ...params,
    learnerBlock: profile.block || undefined,
    personalized: profile.personalized,
    detailed: profile.detailed,
  };
  const encoder = new TextEncoder();
  const iter = streamExplain(enriched, ai)[Symbol.asyncIterator]();
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
      // P32 / P33：前端与插件靠这个 id 定位这段回答（反馈、回看、做卡）
      ...(answerId ? { "X-RF-Answer-Id": answerId } : {}),
    },
  });
}


/** POST body → ExplainParams；word 缺失返回 null */
export function explainParamsFromBody(body: Partial<ExplainParams>): ExplainParams | null {
  const word = typeof body.word === "string" ? body.word.trim() : "";
  if (!word) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    word,
    context: str(body.context) ?? "",
    prefix: str(body.prefix),
    suffix: str(body.suffix),
    language: str(body.language) ?? "en",
    monolingual: body.monolingual === true,
    prompt: str(body.prompt)?.trim() || undefined,
    withPrevSentence: body.withPrevSentence === true,
    signals: narrowSignals((body as { signals?: unknown }).signals),
    // P32：白名单收 askKind；非法值一律按 default，前端说什么都不直接信
    askKind: narrowAskKind((body as { askKind?: unknown }).askKind),
    contextId: str((body as { contextId?: unknown }).contextId)?.slice(0, 120),
    textId: str((body as { textId?: unknown }).textId)?.slice(0, 120),
  };
}

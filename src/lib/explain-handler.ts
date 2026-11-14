/**
 * AI 释义的共用处理（/api/explain 与插件的 /api/extension/explain 共用）。
 * 路由文件只能导出 GET/POST 等固定名字，所以放在这里。
 */
import { streamExplain, explainTurns, type ExplainParams } from "@/lib/ai";
import type { AuthUser } from "@/lib/auth";
import { aiContextFor } from "@/lib/user-secrets";
import { consumeAiQuota, quotaExceededMessage } from "@/lib/ai-quota";
import type { SelectionSignals } from "@/lib/sentence";
import { learnerBlockFor, linkExplainContext, logExplain, saveAnswer } from "@/lib/learner-store";
import { narrowAskKind } from "@/lib/learner/ask-kind";
import { cardsEnabled } from "@/lib/cards/flags";
import { explainCache } from "@/lib/cards/explain-cache";
import { siteCardsSettings } from "@/lib/cards/store";
import { sqlite } from "@/db/sqlite";
import { lemma as lemmaOf } from "@/lib/dict";

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

  // P34：老师笔记改为每晚整理（lib/nightly-note.ts），讲解请求里不再触发。

  // P33（spec §7.1）：观察信息——其他文章查词次数、是否已做过卡。
  // 查询失败不影响讲解（拿不到就不给观察，模型照常工作）。
  let otherTextLookups: number | undefined;
  let cardedBefore: boolean | undefined;
  try {
    otherTextLookups = countOtherTextLookups(user.id, params.word, params.textId);
    cardedBefore = hasPushedCards(user.id, params.word);
  } catch (err) {
    console.error("[cards] 观察信息查询失败:", err);
  }

  // P33：做卡开关是站级的（spec §0.5）。普通账号用自己的 Key 时 ai.settings 里没有站级行，
  // 所以直接读站级 cards.* 行，不从 ai.settings 里取。
  let cardsOn = true;
  try {
    cardsOn = cardsEnabled(siteCardsSettings());
  } catch (err) {
    console.error("[cards] 读取做卡开关失败，按开启处理:", err);
  }

  const enriched: ExplainParams = {
    ...params,
    learnerBlock: profile.block || undefined,
    personalized: profile.personalized,
    detailed: profile.detailed,
    otherTextLookups,
    cardedBefore: cardedBefore === true,
    cardsEnabled: cardsOn,
  };
  const encoder = new TextEncoder();
  const iter = streamExplain(enriched, ai)[Symbol.asyncIterator]();
  let cancelled = false;
  let assistantText = ""; // P33：完整讲解全文（含建议行），缓存做卡用
  let streamDone = false; // 只缓存「完整成功」的结果（spec §7.2）
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (!cancelled) {
          const { value, done } = await iter.next();
          if (done || cancelled) break;
          assistantText += value;
          controller.enqueue(encoder.encode(value));
        }
        streamDone = !cancelled;
        // P34 F1：讲解完整结束 → 对上批注（请求里没有 contextId 时按锚点找）并存下这段回答原文。
        // 失败只记日志，绝不影响讲解。
        let linkedContextId: string | null = params.contextId ?? null;
        if (streamDone && answerId) {
          try {
            linkedContextId = linkExplainContext(user.id, answerId, params.textId, params.anchor);
            saveAnswer({ eventId: answerId, userId: user.id, contextId: linkedContextId, askLabel: params.askLabel, text: assistantText });
          } catch (err) {
            console.error("[learner] 保存回答原文失败:", err);
          }
        }
        // P33（spec §7.2）：讲解流式输出正常结束 → 存进进程内缓存（10 分钟）。
        // messages 与这次调用的逐字一致（含 system 提示词与学生档案），
        // 做卡时前缀复用才能命中模型缓存（spec §13 第 2 条）。
        if (streamDone && answerId && cardsOn && linkedContextId) {
          try {
            explainCache().put(answerId, {
              userId: user.id,
              contextId: linkedContextId,
              messages: explainTurns(enriched),
              assistantText,
              provider: ai.settings?.activeProvider ?? "",
              model: "",
            });
          } catch (err) {
            console.error("[cards] 讲解缓存写入失败:", err);
          }
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


// ---------- P33 观察信息的两个查询（spec §7.1）----------

/** 这个词在其他文章里查过几次（只统计别的 text_id；spec：N 从 contexts 里统计） */
function countOtherTextLookups(userId: string, word: string, textId?: string): number {
  if (!word) return 0;
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT c.text_id AS tid
         FROM contexts c
         JOIN user_words w ON w.id = c.user_word_id
        WHERE w.user_id = ? AND w.lemma = ?`,
    )
    .all(userId, lemmaOf(word).toLowerCase()) as { tid: string }[];
  const others = rows.filter((r) => r.tid !== textId);
  // 每篇别的文章记一次
  return others.length;
}

/** 这个词是否已有推送成功的卡片（carded_before 的取值来源，spec §7.1） */
function hasPushedCards(userId: string, word: string): boolean {
  if (!word) return false;
  const row = sqlite
    .prepare(
      `SELECT 1
         FROM cards k
         JOIN card_sets s ON s.id = k.set_id
         JOIN user_words w ON w.id = s.user_word_id
        WHERE k.user_id = ? AND w.lemma = ? AND k.status = 'pushed'
        LIMIT 1`,
    )
    .get(userId, lemmaOf(word).toLowerCase());
  return row !== undefined;
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
    // P34：「你问：…」标题与选区锚点，只用于存回答、对上批注，不发给模型
    askLabel: str((body as { askLabel?: unknown }).askLabel)?.trim().slice(0, 60) || undefined,
    anchor: narrowAnchor((body as { anchor?: unknown }).anchor),
  };
}

function narrowAnchor(v: unknown): ExplainParams["anchor"] {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const pid = typeof o.paragraphId === "string" ? o.paragraphId.slice(0, 120) : "";
  const start = typeof o.start === "number" && Number.isInteger(o.start) && o.start >= 0 ? o.start : -1;
  const end = typeof o.end === "number" && Number.isInteger(o.end) && o.end > start ? o.end : -1;
  return pid && start >= 0 && end > 0 ? { paragraphId: pid, start, end } : undefined;
}

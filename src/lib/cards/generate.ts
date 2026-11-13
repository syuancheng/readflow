/**
 * 做卡生成流程（P33 spec §7.3）。route.ts 只解析参数，逻辑都在这里。
 *
 * 流程：校验归属 → 去重 → 检查每日额度 → 建 generating 组（立刻返回）→
 * 后台出题（answerId 命中缓存则复用讲解 messages 前缀）→ 解析 → 校验 →
 * 不合格带原因重出一次 → 选择题复核 → 渲染 → 落库 ready。
 * 失败只有一个出口（failSet）：组标 failed，并把预占的名额还回去——**失败不扣次数**。
 */
import { randomUUID } from "node:crypto";
import { sqlite } from "@/db/sqlite";
import { resolveProvider, type ResolvedProvider } from "@/lib/config";
import { aiContextFor } from "@/lib/user-secrets";
import { completeJson, type ChatTurn } from "@/lib/providers";
import { explainTurns } from "@/lib/ai";
import { inlineGloss } from "@/lib/gloss";
import { learnerBlockFor, getLearner, surveyOf } from "@/lib/learner-store";
import { parseCardGen, type CardSpec } from "./spec";
import { validateCard, type ValidateCtx } from "./validate";
import { renderCardChecked } from "./render";
import { buildCardPrompt } from "./prompt";
import { explainCache } from "./explain-cache";
import { cardsEnabled } from "./flags";
import { CARD_DAILY_LIMIT, cardQuotaDay, cardQuotaMessage } from "./quota";
import { examFamilyOf, examStyleLabel, stylePromptLines, type ExamFamily } from "./style";
import {
  cardsUsedToday,
  charLimitOfUser,
  hasPushedCards,
  listeningOn,
  loadCardContext,
  otherTextLookups,
  refundQuota,
  reserveQuota,
  sentenceOf,
  siteCardsSettings,
  type CardContext,
} from "./store";

export const NO_MODEL_MESSAGE = "做卡需要可用的 AI 模型：在 设置 → 模型 里填一个 Key";

/** 一个词最多换几次（spec §7.4）；换一道不计入每天的额度 */
export const MAX_REGEN = 5;
/** generating 超过这么久还没结束（进程重启 / 卡死）就当失败，不能让它永远挡住去重 */
export const STALE_GENERATING_MS = 5 * 60 * 1000;

export type GenerateOutcome =
  | { ok: true; setId: string; reused: boolean }
  | { ok: false; status: number; error: string };

type Who = { id: string; isOwner: boolean };
type Provider = ResolvedProvider;
type Usage = { promptTokens?: number; completionTokens?: number; cacheHitTokens?: number };

const GEN_OPTS = { temperature: 0.4, maxTokens: 1800 } as const;

// ---------- 入口 ----------

/** 生成入口（网站与插件共用）。返回 setId 后台继续，不阻塞响应 */
export function startGenerate(
  user: Who,
  body: { contextId: string; answerId?: string; force?: boolean },
): GenerateOutcome {
  if (!cardsEnabled(siteCardsSettings())) {
    return { ok: false, status: 403, error: "做卡功能已关闭" };
  }
  const ctx = loadCardContext(user.id, body.contextId);
  if (!ctx) return { ok: false, status: 404, error: "这条批注不存在" };

  const ai = aiContextFor(user);
  expireStaleSets(user.id, ai.metered);

  // 去重：已有 generating / ready 且未 force → 直接返回那一组（spec §7.3 第 2 步）
  if (!body.force) {
    const existing = sqlite
      .prepare(
        `SELECT id FROM card_sets
          WHERE user_id = ? AND context_id = ? AND status IN ('generating', 'ready')
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(user.id, body.contextId) as { id: string } | undefined;
    if (existing) return { ok: true, setId: existing.id, reused: true };
  }

  const provider = resolveProvider(ai.settings, ai.env);
  if (!provider) return { ok: false, status: 400, error: NO_MODEL_MESSAGE };

  // 每日额度（spec §7.3 第 3 步）：站点模型 30 个词/天；自带 Key 不限
  if (ai.metered && cardsUsedToday(user.id) >= CARD_DAILY_LIMIT) {
    return { ok: false, status: 429, error: cardQuotaMessage() };
  }

  const now = Date.now();
  const setId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO card_sets (id, user_id, user_word_id, context_id, text_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'generating', ?, ?)`,
    )
    .run(setId, user.id, ctx.word_id, ctx.id, ctx.text_id, now, now);

  // 先预占一个名额（并发请求不会一起冲过上限），失败时由 failSet 还回
  const day = cardQuotaDay(now);
  if (ai.metered) reserveQuota(user.id, day);

  // 后台执行，不 await（spec §7.3 第 4 步：立刻返回）
  void (async () => {
    try {
      const r = await runGenerate(user, ctx, provider, setId, body.answerId);
      if (!r.ok) failSet(setId, user.id, r.reason, ai.metered ? day : null);
    } catch (err) {
      console.error("[cards] 生成失败:", err);
      failSet(setId, user.id, err instanceof Error ? err.message : "生成失败", ai.metered ? day : null);
    }
  })();

  return { ok: true, setId, reused: false };
}

// ---------- 后台生成 ----------

type RunResult = { ok: true } | { ok: false; reason: string };

async function runGenerate(
  user: Who,
  ctx: CardContext,
  provider: Provider,
  setId: string,
  answerId: string | undefined,
): Promise<RunResult> {
  const run = buildRun(user, ctx, answerId);

  // 1) 出题；解析失败重出一次（spec §7.3 第 8 步）
  let usage: Usage = {};
  let parsed = parseCardGen("");
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await completeJson(provider, run.messages, GEN_OPTS);
    usage = res.usage;
    parsed = parseCardGen(res.text);
    if (parsed.ok) break;
  }
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  // 2) 校验 → 重出 → 选择题复核
  const settled: { spec: CardSpec; needsReview: string | null }[] = [];
  for (const raw of parsed.cards) {
    const out = await settleCard(provider, run, raw);
    if (out) settled.push(out);
  }
  if (settled.length === 0) return { ok: false, reason: "所有卡片都没有通过校验" };

  // 3) 渲染 + 落库
  const now = Date.now();
  const rows: { spec: CardSpec; content: string; needsReview: string | null }[] = [];
  for (const { spec, needsReview } of settled) {
    const rendered = renderCardChecked(spec, { sourceTitle: ctx.text_title ?? "" }, { charLimit: run.vctx.charLimit });
    if (rendered.ok) rows.push({ spec, content: rendered.content, needsReview });
  }
  if (rows.length === 0) return { ok: false, reason: "所有卡片渲染失败" };

  sqlite.transaction(() => {
    const insert = sqlite.prepare(
      `INSERT INTO cards (id, set_id, user_id, seq, spec, content, status, needs_review, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    );
    rows.forEach((r, i) =>
      insert.run(randomUUID(), setId, user.id, i, JSON.stringify(r.spec), r.content, r.needsReview, now, now),
    );
    sqlite
      .prepare(
        `UPDATE card_sets SET status = 'ready', cache_hit_tokens = ?, prompt_tokens = ?,
           completion_tokens = ?, updated_at = ? WHERE id = ?`,
      )
      .run(usage.cacheHitTokens ?? null, usage.promptTokens ?? null, usage.completionTokens ?? null, now, setId);
  })();
  return { ok: true };
}

// ---------- 组织对话 ----------

type Run = {
  /** 讲解对话 + 出题指令；重出 / 换一道在它后面接着追加 */
  messages: ChatTurn[];
  vctx: ValidateCtx;
  family: ExamFamily | null;
  cacheHit: boolean;
};

/**
 * 组织出题请求（spec §7.3 第 5 步）。
 * - 命中缓存：讲解的 messages 逐字复用 + 讲解全文 + 出题指令。前缀必须与讲解那次
 *   逐字一致，模型的前缀缓存才会命中，所以学生档案用缓存里那份，不重新计算。
 * - 没命中：按同样的规则重新组织一份讲解对话，学生档案现读。
 */
function buildRun(user: Who, ctx: CardContext, answerId: string | undefined): Run {
  const cached = answerId ? explainCache().get(answerId, user.id, ctx.id) : null;

  let base: ChatTurn[];
  let learnerBlock: string;
  if (cached) {
    base = [...cached.messages, { role: "assistant", content: cached.assistantText }];
    learnerBlock = learnerBlockOfMessages(cached.messages);
  } else {
    let profile = { block: "", detailed: false, personalized: false };
    try {
      profile = learnerBlockFor(user.id);
    } catch (err) {
      console.error("[cards] 读取学习档案失败，按无档案出题:", err);
    }
    const lookups = otherTextLookups(user.id, ctx.lemma, ctx.text_id);
    const carded = hasPushedCards(user.id, ctx.word_id);
    base = [
      ...explainTurns({
        word: ctx.display_form,
        context: sentenceOf(ctx),
        prefix: ctx.prefix || undefined,
        suffix: ctx.suffix || undefined,
        learnerBlock: profile.block || undefined,
        personalized: profile.personalized,
        detailed: profile.detailed,
        otherTextLookups: lookups,
        cardedBefore: carded,
        cardsEnabled: true,
      }),
      ...(ctx.ai_gloss ? [{ role: "assistant" as const, content: ctx.ai_gloss }] : []),
    ];
    learnerBlock = profile.block;
  }

  const family = examFamilyOf(surveyFor(user.id));
  const listening = listeningOn();
  const prompt = buildCardPrompt({
    learnerBlock,
    styleLines: stylePromptLines(family, surveyFor(user.id)),
    listeningEnabled: listening,
    otherTextLookups: otherTextLookups(user.id, ctx.lemma, ctx.text_id),
    cardedBefore: hasPushedCards(user.id, ctx.word_id),
  });

  return {
    messages: [...base, { role: "user", content: prompt }],
    vctx: {
      originalSentence: sentenceOf(ctx),
      quote: ctx.quote,
      glossZh: inlineGloss(ctx.ai_gloss, ctx.translation, 40) || null,
      listeningEnabled: listening,
      charLimit: charLimitOfUser(user.id),
      sourceTitle: ctx.text_title ?? "",
    },
    family,
    cacheHit: cached !== null,
  };
}

function surveyFor(userId: string) {
  try {
    return surveyOf(getLearner(userId));
  } catch {
    return null;
  }
}

/** 从讲解 messages 的第一条 user 消息里取学生档案块（它在「用户选中:」之前） */
export function learnerBlockOfMessages(messages: { role: string; content: string }[]): string {
  const u = messages.find((m) => m.role === "user");
  if (!u) return "";
  return u.content.match(/^([\s\S]*?)\n\n用户选中:/)?.[1] ?? "";
}

// ---------- 单张卡：校验 / 重出 / 复核 ----------

/** 考试风格标签由系统按学生档案写死，AI 自己填的不算数 */
function withStyle(spec: CardSpec, family: ExamFamily | null): CardSpec {
  return { ...spec, examStyle: examStyleLabel(family, spec.kind) };
}

/**
 * 一张卡从「模型原始输出」到「可入库」：
 * 校验不过 → 带原因重出一次；仍不过 → 丢掉（返回 null）。
 * 选择题再做一次独立复核：有疑问 → 重出一次；仍有疑问 → 保留草稿但标 needs_review。
 */
async function settleCard(
  provider: Provider,
  run: Run,
  raw: CardSpec,
): Promise<{ spec: CardSpec; needsReview: string | null } | null> {
  let spec = withStyle(raw, run.family);
  let v = validateCard(spec, run.vctx);
  if (!v.ok) {
    const again = await redo(provider, run, spec, v.reasons.join("；"));
    if (!again) return null;
    spec = again;
    v = validateCard(spec, run.vctx);
    if (!v.ok) return null;
  }

  if (!hasChoice(spec)) return { spec, needsReview: null };

  let review = await reviewChoice(provider, run.vctx.originalSentence, spec);
  if (review === "ok") return { spec, needsReview: null };

  const again = await redo(provider, run, spec, REVIEW_REASON);
  if (again && validateCard(again, run.vctx).ok) {
    spec = again;
    review = hasChoice(spec) ? await reviewChoice(provider, run.vctx.originalSentence, spec) : "ok";
    if (review === "ok") return { spec, needsReview: null };
  }
  return { spec, needsReview: REVIEW_REASON };
}

const REVIEW_REASON = "复核发现可能有多个正确答案";

function hasChoice(spec: CardSpec): boolean {
  return spec.front.some((b) => b.t === "choice");
}

/** 接着当前对话重出这一张：带上上一版输出和不合格的原因，模型才知道要改什么 */
async function redo(provider: Provider, run: Run, prev: CardSpec, reason: string): Promise<CardSpec | null> {
  const turns: ChatTurn[] = [
    ...run.messages,
    { role: "assistant", content: JSON.stringify({ cards: [prev] }) },
    {
      role: "user",
      content: `这张卡不合格：${reason}。请只重新出这一张卡，其余要求不变。返回 { "cards": [ 一张卡 ] }。`,
    },
  ];
  try {
    const res = await completeJson(provider, turns, { temperature: 0.4, maxTokens: 1200 });
    const parsed = parseCardGen(res.text);
    return parsed.ok ? withStyle(parsed.cards[0], run.family) : null;
  } catch (err) {
    console.error("[cards] 重出失败:", err);
    return null;
  }
}

/**
 * 选择题复核（spec §5.3）：不告诉模型答案，让它自己判断哪些选项说得通。
 * 选项编号从 1 开始，所以拿 correct 的下标 + 1 去比。两边完全一致才算通过。
 */
export async function reviewChoice(
  provider: Provider,
  sentence: string,
  spec: CardSpec,
): Promise<"ok" | "mismatch"> {
  const choice = spec.front.find((b) => b.t === "choice");
  if (!choice || choice.t !== "choice") return "ok";
  const expected = choice.options.flatMap((o, i) => (o.correct ? [i + 1] : []));
  const shown = spec.front.find((b) => b.t === "sentence");
  const question = spec.front.find((b) => b.t === "instruction");
  const ask: ChatTurn[] = [
    { role: "system", content: "你是考生的英语老师，正在检查一道选择题是否有多个说得通的答案。只输出 JSON。" },
    {
      role: "user",
      content: `原句：${shown && shown.t === "sentence" ? shown.text : sentence}\n题目：${
        question && question.t === "instruction" ? question.text : ""
      }\n选项：\n${choice.options.map((o, i) => `${i + 1}. ${o.text}`).join("\n")}\n\n作为考生，哪些选项可以是正确答案？请返回 JSON：{ "possible": number[] }（编号从 1 开始）`,
    },
  ];
  try {
    const res = await completeJson(provider, ask, { temperature: 0, maxTokens: 200 });
    return samePossible(JSON.parse(res.text), expected) ? "ok" : "mismatch";
  } catch {
    return "mismatch";
  }
}

/** possible 与正确答案编号完全一致（顺序、重复无关）；导出供单测 */
export function samePossible(parsed: unknown, expected: number[]): boolean {
  const possible = (parsed as { possible?: unknown } | null)?.possible;
  if (!Array.isArray(possible)) return false;
  const got = [...new Set(possible.filter((n): n is number => typeof n === "number"))].sort((a, b) => a - b);
  const want = [...new Set(expected)].sort((a, b) => a - b);
  return got.length === want.length && got.every((n, i) => n === want[i]);
}

// ---------- 换一道 ----------

export type RegenOutcome = { ok: true } | { ok: false; status: number; error: string };

/**
 * 换一道（spec §7.4）：沿用这个词的完整上下文，把当前这张卡当「不要重复」的参考。
 * 不计入每天额度；每组最多 MAX_REGEN 次。
 */
export async function regenerateCard(user: Who, cardId: string): Promise<RegenOutcome> {
  const card = sqlite
    .prepare("SELECT id, set_id, spec, status FROM cards WHERE id = ? AND user_id = ?")
    .get(cardId, user.id) as { id: string; set_id: string; spec: string; status: string } | undefined;
  if (!card) return { ok: false, status: 404, error: "卡片不存在" };
  if (card.status !== "draft") return { ok: false, status: 400, error: "只有草稿卡可以换一道" };

  const set = sqlite
    .prepare("SELECT id, regen_count, context_id FROM card_sets WHERE id = ? AND user_id = ?")
    .get(card.set_id, user.id) as { id: string; regen_count: number; context_id: string } | undefined;
  if (!set) return { ok: false, status: 404, error: "卡片组不存在" };
  if (set.regen_count >= MAX_REGEN) {
    return { ok: false, status: 429, error: `这一组最多换 ${MAX_REGEN} 次` };
  }

  const ctx = loadCardContext(user.id, set.context_id);
  if (!ctx) return { ok: false, status: 404, error: "批注不存在" };
  const ai = aiContextFor(user);
  const provider = resolveProvider(ai.settings, ai.env);
  if (!provider) return { ok: false, status: 400, error: NO_MODEL_MESSAGE };

  const run = buildRun(user, ctx, undefined);
  const prev = JSON.parse(card.spec) as CardSpec;
  const turns: ChatTurn[] = [
    ...run.messages,
    { role: "assistant", content: JSON.stringify({ cards: [prev] }) },
    {
      role: "user",
      content: `学生觉得这张卡不合适，请换一道：考点或题型要和上一张不同（上一张是 ${prev.kind}）。只出一张。返回 { "cards": [ 一张卡 ] }。`,
    },
  ];

  let next: CardSpec;
  try {
    const res = await completeJson(provider, turns, GEN_OPTS);
    const parsed = parseCardGen(res.text);
    if (!parsed.ok) return { ok: false, status: 502, error: parsed.reason };
    next = withStyle(parsed.cards[0], run.family);
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : "模型调用失败" };
  }

  const v = validateCard(next, run.vctx);
  if (!v.ok) return { ok: false, status: 400, error: `新卡片不合格：${v.reasons.join("；")}，再试一次` };

  const review = hasChoice(next) ? await reviewChoice(provider, run.vctx.originalSentence, next) : "ok";
  const rendered = renderCardChecked(next, { sourceTitle: ctx.text_title ?? "" }, { charLimit: run.vctx.charLimit });
  if (!rendered.ok) return { ok: false, status: 400, error: rendered.problems.join("；") };

  const now = Date.now();
  sqlite.transaction(() => {
    // 原卡作废（软删，保留统计口径）；新卡接在组尾
    sqlite.prepare("UPDATE cards SET status = 'discarded', updated_at = ? WHERE id = ?").run(now, card.id);
    const maxSeq = sqlite
      .prepare("SELECT COALESCE(MAX(seq), -1) AS m FROM cards WHERE set_id = ?")
      .get(card.set_id) as { m: number };
    sqlite
      .prepare(
        `INSERT INTO cards (id, set_id, user_id, seq, spec, content, status, needs_review, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(
        randomUUID(), card.set_id, user.id, maxSeq.m + 1, JSON.stringify(next), rendered.content,
        review === "ok" ? null : REVIEW_REASON, now, now,
      );
    sqlite
      .prepare("UPDATE card_sets SET regen_count = regen_count + 1, updated_at = ? WHERE id = ?")
      .run(now, card.set_id);
  })();
  return { ok: true };
}

// ---------- 失败出口 / 过期清理 ----------

/** 组标 failed，并把预占的名额还回去。day 为 null 表示这次没占（自带 Key） */
function failSet(setId: string, userId: string, reason: string, day: string | null): void {
  sqlite
    .prepare("UPDATE card_sets SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .run(reason, Date.now(), setId);
  if (day) refundQuota(userId, day);
}

/** 进程重启 / 卡死留下的 generating 组：超时就当失败，并还名额 */
function expireStaleSets(userId: string, metered: boolean): void {
  const cutoff = Date.now() - STALE_GENERATING_MS;
  const stale = sqlite
    .prepare("SELECT id, created_at FROM card_sets WHERE user_id = ? AND status = 'generating' AND created_at < ?")
    .all(userId, cutoff) as { id: string; created_at: number }[];
  for (const s of stale) {
    failSet(s.id, userId, "生成超时，请重试", metered ? cardQuotaDay(s.created_at) : null);
  }
}

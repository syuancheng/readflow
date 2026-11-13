/**
 * P32 F2：行为推断（不调用模型、不花钱）。
 *
 * 所有规则都是纯函数：只吃事件数组和时间戳，不碰数据库。
 * 换算 / 阈值逐条来自实现说明 §4.2，单测见 learner-model.test.ts。
 */
import { cefrOfVocab } from "./survey";
import type { BehaviorStats, Cefr, LearnerEvent, LearnerLevel } from "./types";

export const MIN_LOOKUPS = 30;
export const WINDOW_DAYS = 90;
export const FOLLOWUP_WINDOW_MS = 10 * 60 * 1000;
export const VOCAB_MIN = 1000;
export const VOCAB_MAX = 20000;

/** 排名的第 20 百分位（nearest-rank）：一个人连常用词都还在查，水平大致就在这附近 */
export function percentile20(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.max(0, Math.ceil(sorted.length * 0.2) - 1);
  return sorted[i];
}

/**
 * 只统计最近 90 天、且在「清空 AI 记忆」之后的事件。
 * 取消记录的查词仍然计入（查过就说明当时不会），所以事件表里不去重。
 */
export function computeBehaviorStats(
  events: LearnerEvent[],
  now: number,
  memoryResetAt = 0,
): BehaviorStats {
  const cutoff = now - WINDOW_DAYS * 24 * 3600 * 1000;
  const all = events.filter((e) => e.createdAt >= cutoff && e.createdAt > memoryResetAt && e.createdAt <= now);

  const lookups = all.filter((e) => e.kind === "lookup");
  const ranked = lookups.filter((e) => !e.isPhrase && e.freqRank !== null).map((e) => e.freqRank as number);
  const p20 = percentile20(ranked);
  const vocab = ranked.length >= MIN_LOOKUPS && p20 !== null
    ? Math.max(VOCAB_MIN, Math.min(VOCAB_MAX, Math.round(p20)))
    : null;
  const cefr: Cefr | null = vocab === null ? null : cefrOfVocab(vocab);

  // 读过最多的文章难度：出现次数最多的 CEFR（并列时按 A2→C2 的既定顺序取先者）
  const cefrOrder: Cefr[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
  const textCefrCount = new Map<string, number>();
  for (const e of lookups) {
    if (!e.textCefr) continue;
    const key = e.textCefr.toUpperCase();
    textCefrCount.set(key, (textCefrCount.get(key) ?? 0) + 1);
  }
  let typicalTextCefr: Cefr | null = null;
  for (const level of cefrOrder) {
    if (textCefrCount.has(level) && (typicalTextCefr === null ||
      (textCefrCount.get(level) ?? 0) > (textCefrCount.get(typicalTextCefr) ?? 0))) {
      typicalTextCefr = level;
    }
  }

  const total = lookups.length;
  const structureAsks = all.filter(
    (e) => e.kind === "explain" && (e.askKind === "whole_sentence" || e.askKind === "structure"),
  ).length;
  const repeated = lookups.filter((e) => (e.repeatCount ?? 0) >= 2).length;
  const longRatio = total > 0 ? (structureAsks + repeated) / total : 0;
  const phraseRatio = total > 0 ? lookups.filter((e) => e.isPhrase).length / total : 0;

  const hits: { key: BehaviorStats["difficulties"][number]; score: number }[] = [];
  if (longRatio >= 0.1) hits.push({ key: "long_sentence", score: longRatio });
  if (phraseRatio >= 0.25) hits.push({ key: "phrases", score: phraseRatio });
  if (vocab !== null && vocab < 4000) hits.push({ key: "vocabulary", score: 1 - vocab / 4000 });
  const difficulties = hits.sort((a, b) => b.score - a.score).slice(0, 3).map((h) => h.key);

  // 追问率：auto/default 讲解之后，同一处 10 分钟内又请教了别的种类
  const explains = all.filter((e) => e.kind === "explain");
  const base = explains.filter(
    (e) => (e.askKind === "auto" || e.askKind === "default") && e.contextId !== null,
  );
  let followed = 0;
  for (const b of base) {
    if (explains.some((e) =>
      e !== b && e.contextId === b.contextId &&
      e.createdAt > b.createdAt && e.createdAt - b.createdAt <= FOLLOWUP_WINDOW_MS &&
      e.askKind !== b.askKind,
    )) followed++;
  }
  const followupRate = base.length > 0 ? followed / base.length : null;

  const feedback = { shallow: 0, right: 0, deep: 0 };
  for (const e of explains) {
    if (e.feedback === "shallow" || e.feedback === "right" || e.feedback === "deep") {
      feedback[e.feedback]++;
    }
  }

  return { lookups: total, vocab, cefr, typicalTextCefr, difficulties, followupRate, feedback };
}

/**
 * 问卷 vs 行为数据的合并：
 * - 查词 < 30 次：只用问卷；
 * - 30–99 次：w = (n - 30) / 70 线性混合；
 * - ≥100 次：只用行为数据；
 * - 两者都没有：null（讲解行为等同于没有画像）。
 */
export function mergeProfile(
  prior: { vocab: number | null; cefr: Cefr | null } | null,
  stats: BehaviorStats | null,
): LearnerLevel | null {
  const hasPrior = Boolean(prior && prior.vocab !== null);
  const hasStats = Boolean(stats && stats.vocab !== null && stats.lookups >= MIN_LOOKUPS);
  if (!hasPrior && !hasStats) return null;

  const pv = prior?.vocab ?? null;
  const sv = stats?.vocab ?? null;
  if (hasPrior && !hasStats) return { vocab: pv, cefr: prior!.cefr, basis: "survey" };
  if (!hasPrior && hasStats) return { vocab: sv, cefr: stats!.cefr, basis: "behavior" };

  const n = stats!.lookups;
  if (n >= 100) return { vocab: sv, cefr: cefrOfVocab(sv as number), basis: "behavior" };
  const w = (n - MIN_LOOKUPS) / 70;
  const vocab = Math.round((pv as number) * (1 - w) + (sv as number) * w);
  return { vocab, cefr: cefrOfVocab(vocab), basis: "mixed" };
}

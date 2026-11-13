import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_LOOKUPS,
  WINDOW_DAYS,
  FOLLOWUP_WINDOW_MS,
  VOCAB_MIN,
  VOCAB_MAX,
  percentile20,
  computeBehaviorStats,
  mergeProfile,
} from "../../src/lib/learner/model";
import { EMPTY_BEHAVIOR_STATS, type LearnerEvent } from "../../src/lib/learner/types";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DAY = 24 * 3600 * 1000;
const ev = (over: Partial<LearnerEvent> = {}): LearnerEvent => ({
  kind: "lookup",
  freqRank: null,
  isPhrase: false,
  repeatCount: null,
  textCefr: null,
  feedback: null,
  createdAt: NOW,
  contextId: null,
  ...over,
});
const lookups = (n: number, freqRank = 3000, more: Partial<LearnerEvent> = {}) =>
  Array.from({ length: n }, () => ev({ freqRank, ...more }));
const stats = (over: Partial<typeof EMPTY_BEHAVIOR_STATS> = {}) => ({ ...EMPTY_BEHAVIOR_STATS, ...over });

test("第 20 百分位：nearest-rank，且不是平均值", () => {
  assert.equal(percentile20([]), null);
  assert.equal(percentile20([1000, 2000, 3000, 4000, 5000]), 1000);
  assert.equal(percentile20([5000, 1000, 4000, 2000, 3000]), 1000);
  assert.equal(percentile20([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 2);
});

test("30 次阈值：29 次不估词汇量，30 次才开始用行为数据", () => {
  assert.equal(MIN_LOOKUPS, 30);
  const s29 = computeBehaviorStats(lookups(29), NOW);
  assert.equal(s29.vocab, null);
  assert.equal(s29.cefr, null);
  assert.equal(s29.lookups, 29);
  const s30 = computeBehaviorStats(lookups(30), NOW);
  assert.equal(s30.vocab, 3000);
  assert.equal(s30.cefr, "B1");
});

test("90 天窗口：89 天前的算，91 天前的不算", () => {
  assert.equal(WINDOW_DAYS, 90);
  const inside = lookups(29, 3000, { createdAt: NOW - 89 * DAY });
  const outside = lookups(29, 3000, { createdAt: NOW - 91 * DAY });
  assert.equal(computeBehaviorStats([...inside, ev({ freqRank: 3000 })], NOW).lookups, 30);
  assert.equal(computeBehaviorStats([...outside, ev({ freqRank: 3000 })], NOW).lookups, 1);
  assert.equal(computeBehaviorStats([...outside, ev({ freqRank: 3000 })], NOW).vocab, null);
});

test("词汇量夹在 1000–20000；短语和没有词频排名的事件不参与", () => {
  assert.equal(VOCAB_MIN, 1000);
  assert.equal(VOCAB_MAX, 20000);
  assert.equal(computeBehaviorStats(lookups(30, 10), NOW).vocab, 1000);
  assert.equal(computeBehaviorStats(lookups(30, 99000), NOW).vocab, 20000);
  const mixed = [...lookups(30, 5000), ...lookups(20, 3000, { isPhrase: true }), ...lookups(20, 1000, { freqRank: null })];
  const s = computeBehaviorStats(mixed, NOW);
  assert.equal(s.lookups, 70, "短语也算查词次数");
  assert.equal(s.vocab, 5000, "但短语和无排名的不算词汇量样本");
});

test("主要难点：长句 ≥10%、短语 ≥25%、词汇量 <4000，按强度排序且最多 3 条", () => {
  const none = computeBehaviorStats(lookups(30, 6000), NOW);
  assert.deepEqual(none.difficulties, []);

  const longOnly = computeBehaviorStats([
    ...lookups(30, 6000),
    ...Array.from({ length: 3 }, () => ev({ kind: "explain", askKind: "whole_sentence" })),
  ], NOW);
  assert.deepEqual(longOnly.difficulties, ["long_sentence"], "3/30 = 10%");

  const phrase = computeBehaviorStats([...lookups(22, 6000), ...lookups(8, 6000, { isPhrase: true })], NOW);
  assert.deepEqual(phrase.difficulties, ["phrases"], "8/30 ≈ 26.7%");

  const all = computeBehaviorStats([
    ...lookups(30, 2500),
    ...lookups(6, 2500, { isPhrase: true, repeatCount: 2 }),
    ...lookups(4, 2500, { isPhrase: true }),
    ev({ kind: "explain", askKind: "structure" }),
  ], NOW);
  assert.equal(all.difficulties.length, 3);
  assert.ok(all.difficulties.includes("vocabulary") && all.difficulties.includes("phrases") && all.difficulties.includes("long_sentence"));
  assert.equal(all.difficulties[0], "vocabulary", "词汇量偏小强度最高时排最前");
});

test("追问率：auto/default 之后同一处 10 分钟内又请教别的种类才算", () => {
  const base = ev({ kind: "explain", askKind: "auto", contextId: "c1", createdAt: NOW - 5 * 60 * 1000 });
  const soon = ev({ kind: "explain", askKind: "structure", contextId: "c1", createdAt: NOW - 4 * 60 * 1000 });
  const late = ev({ kind: "explain", askKind: "example", contextId: "c2", createdAt: NOW - 1 });
  assert.equal(computeBehaviorStats([base, soon], NOW).followupRate, 1);
  assert.equal(computeBehaviorStats([base, late], NOW).followupRate, 0, "不同记录不算追问");
  const tooLate = ev({ kind: "explain", askKind: "structure", contextId: "c1", createdAt: base.createdAt + FOLLOWUP_WINDOW_MS + 1 });
  assert.equal(computeBehaviorStats([base, tooLate], NOW).followupRate, 0, "超过 10 分钟不算");
  assert.equal(computeBehaviorStats([], NOW).followupRate, null, "没有自动讲解时为 null");
});

test("常读文章难度取出现次数最多的 CEFR，并列时取较低级", () => {
  const s = computeBehaviorStats([
    ...lookups(5, 3000, { textCefr: "B2" }),
    ...lookups(2, 3000, { textCefr: "C1" }),
    ...lookups(2, 3000, { textCefr: "B1" }),
  ], NOW);
  assert.equal(s.typicalTextCefr, "B2");
  const tie = computeBehaviorStats([...lookups(1, 3000, { textCefr: "B2" }), ...lookups(1, 3000, { textCefr: "C1" })], NOW);
  assert.equal(tie.typicalTextCefr, "B2");
});

test("反馈计数：只统计 explain 事件里的三类反馈", () => {
  const s = computeBehaviorStats([
    ev({ kind: "explain", feedback: "deep" }),
    ev({ kind: "explain", feedback: "deep" }),
    ev({ kind: "explain", feedback: "shallow" }),
    ev({ kind: "lookup", feedback: "right" }),
  ], NOW);
  assert.deepEqual(s.feedback, { shallow: 1, right: 0, deep: 2 });
});

test("mergeProfile：29 次只用问卷，30 / 65 / 99 次线性混合，100 次只用行为", () => {
  const prior = { vocab: 4000, cefr: "B2" as const };
  assert.deepEqual(mergeProfile(prior, stats({ lookups: 29, vocab: 8000, cefr: "C1" })),
    { vocab: 4000, cefr: "B2", basis: "survey" });
  assert.deepEqual(mergeProfile(prior, stats({ lookups: 30, vocab: 8000, cefr: "C1" })),
    { vocab: 4000, cefr: "B2", basis: "mixed" }, "w=0 时等于问卷");
  assert.deepEqual(mergeProfile(prior, stats({ lookups: 65, vocab: 8000, cefr: "C1" })),
    { vocab: 6000, cefr: "B2", basis: "mixed" }, "w=0.5 时取中值");
  assert.deepEqual(mergeProfile(prior, stats({ lookups: 99, vocab: 8000, cefr: "C1" })),
    { vocab: 7943, cefr: "C1", basis: "mixed" }, "w≈0.986");
  assert.deepEqual(mergeProfile(prior, stats({ lookups: 100, vocab: 8000, cefr: "C1" })),
    { vocab: 8000, cefr: "C1", basis: "behavior" });
  assert.deepEqual(mergeProfile(null, stats({ lookups: 50, vocab: 7000, cefr: "C1" })),
    { vocab: 7000, cefr: "C1", basis: "behavior" });
  assert.equal(mergeProfile(null, stats()), null, "两者都没有时返回 null");
  assert.deepEqual(mergeProfile(prior, stats({ lookups: 50, vocab: null })),
    { vocab: 4000, cefr: "B2", basis: "survey" }, "行为侧没有词汇量时退回问卷");
});

test("清空 AI 记忆：memory_reset_at 之前的事件全部排除", () => {
  const before = lookups(40, 9000, { createdAt: NOW - 10 * DAY });
  const after = lookups(5, 2000, { createdAt: NOW - 1 * DAY });
  const s = computeBehaviorStats([...before, ...after], NOW, NOW - 5 * DAY);
  assert.equal(s.lookups, 5);
  assert.equal(s.vocab, null);
});

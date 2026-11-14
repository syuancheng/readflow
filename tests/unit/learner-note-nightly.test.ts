import assert from "node:assert/strict";
import test from "node:test";
import {
  answerExcerpt,
  buildNightlyNotePrompt,
  EXPLAIN_RETENTION_DAYS,
  EXPLAIN_RETENTION_MAX_DAYS,
  formatNoteTime,
  LOOKUP_RETENTION_DAYS,
  NIGHTLY_ANSWER_EXCERPT,
  NIGHTLY_ANSWERED_MAX,
  NIGHTLY_HOUR,
  NIGHTLY_MIN_NEW_EVENTS,
  nightlyDue,
  nightlyEligible,
  retentionCutoffs,
  shanghaiDay,
  shanghaiHour,
} from "../../src/lib/learner/nightly";
import { EMPTY_BEHAVIOR_STATS } from "../../src/lib/learner/types";

const DAY = 24 * 3600 * 1000;
// 北京时间 2026-11-14 03:00 = UTC 2026-11-13 19:00
const T3 = Date.UTC(2026, 10, 13, 19, 0, 0);

test("常量：凌晨 3 点、攒够 10 次、讲解 30 / 90 天、查词 90 天（PRD Q6 / Q7 / Q9）", () => {
  assert.equal(NIGHTLY_HOUR, 3);
  assert.equal(NIGHTLY_MIN_NEW_EVENTS, 10);
  assert.equal(EXPLAIN_RETENTION_DAYS, 30);
  assert.equal(EXPLAIN_RETENTION_MAX_DAYS, 90);
  assert.equal(LOOKUP_RETENTION_DAYS, 90);
});

test("北京时间：日期与小时按 Asia/Shanghai 计算", () => {
  assert.equal(shanghaiDay(T3), "2026-11-14");
  assert.equal(shanghaiHour(T3), 3);
  assert.equal(shanghaiHour(T3 - 60_000), 2);
  assert.equal(shanghaiDay(T3 - 60_000), "2026-11-14");
  assert.equal(shanghaiDay(T3 - 3 * 3600_000 - 1), "2026-11-13");
});

test("nightlyDue：02:59 不跑，03:00 跑；今天跑过不再跑；跨日后又该跑；凌晨没开机时白天补做", () => {
  assert.equal(nightlyDue(T3 - 60_000, null), false);
  assert.equal(nightlyDue(T3, null), true);
  assert.equal(nightlyDue(T3, "2026-11-13"), true);
  assert.equal(nightlyDue(T3, "2026-11-14"), false);
  assert.equal(nightlyDue(T3 + 10 * 3600_000, "2026-11-13"), true, "白天启动时补做");
  assert.equal(nightlyDue(T3 + DAY, "2026-11-14"), true, "第二天又该跑");
  assert.equal(nightlyDue(T3, null, 5), false, "可配置的小时");
});

test("nightlyEligible：个性化开启且新动静满 10 次（9 次不跑）", () => {
  assert.equal(nightlyEligible({ personalized: true, newEvents: 10 }), true);
  assert.equal(nightlyEligible({ personalized: true, newEvents: 9 }), false);
  assert.equal(nightlyEligible({ personalized: false, newEvents: 99 }), false);
  assert.equal(nightlyEligible({ personalized: true, newEvents: 3 }, 3), true);
});

test("retentionCutoffs：讲解 30 天 / 90 天、查词 90 天", () => {
  const c = retentionCutoffs(T3);
  assert.equal(c.explain, T3 - 30 * DAY);
  assert.equal(c.explainMax, T3 - 90 * DAY);
  assert.equal(c.lookup, T3 - 90 * DAY);
});

test("formatNoteTime：今天 / 昨天 / 更早（北京时间）", () => {
  assert.equal(formatNoteTime(T3, T3 + 3600_000), "今天 03:00");
  assert.equal(formatNoteTime(T3 - DAY + 18 * 3600_000 + 10 * 60_000, T3), "昨天 21:10");
  assert.equal(formatNoteTime(T3 - 2 * DAY, T3), "11月12日 03:00");
});

const base = { oldNote: "偏好简短解释。", userEdited: false, stats: EMPTY_BEHAVIOR_STATS, recent: [] };

test("buildNightlyNotePrompt：插在旧笔记之前，写明完整重写、来自所有文章、同类至少 3 次，不写英文原词", () => {
  const p = buildNightlyNotePrompt({
    ...base,
    answered: [{ feedback: "deep", askKind: "auto", askLabel: null, isPhrase: false, answerText: "释义：通用的\n==主语：The design== is generic.\n这里讲得很长。\n制卡建议：x" }],
  });
  assert.ok(p.system.includes("每晚整理") && p.system.includes("完整重写") && p.system.includes("所有文章") && p.system.includes("至少出现 3 次"));
  const i = p.user.indexOf("【带回答的反馈");
  assert.ok(i > 0 && i < p.user.indexOf("【上一版老师笔记】"));
  assert.ok(p.user.includes("- 单词，自动讲解：") && p.user.includes("→ 太深"));
  assert.ok(p.user.includes("回答开头：释义：通用的"));
  assert.ok(!p.user.includes("制卡建议"), "回答开头去掉建议行");
});

test("buildNightlyNotePrompt：没有带回答的反馈时写「暂无」；最多 30 组", () => {
  assert.ok(buildNightlyNotePrompt({ ...base, answered: [] }).user.includes("【带回答的反馈（来自所有文章，从新到旧）】\n暂无。"));
  const many = Array.from({ length: 40 }, () => ({ feedback: "right", askKind: "auto", askLabel: null, isPhrase: false, answerText: null }));
  const u = buildNightlyNotePrompt({ ...base, answered: many }).user;
  assert.equal((u.match(/→ 刚好/g) ?? []).length, NIGHTLY_ANSWERED_MAX);
});

test("answerExcerpt：去掉建议行、压成一行、截到 300 字", () => {
  assert.equal(answerExcerpt(null), "");
  assert.equal(answerExcerpt("释义：x\n第二行\n制卡建议：y"), "释义：x 第二行");
  const long = "字".repeat(NIGHTLY_ANSWER_EXCERPT + 5);
  assert.equal(answerExcerpt(long), `${"字".repeat(NIGHTLY_ANSWER_EXCERPT)}…`);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLearnerBlock,
  dominantFeedback,
  hasUsableProfile,
  LEARNER_BLOCK_MAX_CHARS,
} from "../../src/lib/learner/profile-text";
import { EMPTY_BEHAVIOR_STATS, type BehaviorStats, type LearnerLevel } from "../../src/lib/learner/types";

const stats = (over: Partial<BehaviorStats> = {}): BehaviorStats => ({
  ...EMPTY_BEHAVIOR_STATS,
  feedback: { shallow: 0, right: 0, deep: 0 },
  ...over,
});
const full = {
  level: { vocab: 5750, cefr: "B2" as const },
  survey: {
    identity: "work_3_10" as const,
    goals: ["tech" as const],
    stylePref: "concise" as const,
  },
  stats: stats({ lookups: 186, difficulties: ["long_sentence"], feedback: { shallow: 0, right: 1, deep: 6 } }),
  note: "技术词汇强于日常词汇。",
};

test("格式固定：标题行 + 每一行都按文档写", () => {
  const lines = buildLearnerBlock(full).split("\n");
  assert.equal(lines[0], "学生档案（供你判断讲多深、讲什么；回答里不要提到这些信息）：");
  assert.equal(lines[1], "- 估计水平：B2，词汇量约 4900–6600（依据：最近 186 次查词 + 问卷）");
  assert.equal(lines[2], "- 身份：已工作 3–10 年");
  assert.equal(lines[3], "- 主要阅读：技术文档和编程");
  assert.equal(lines[4], "- 希望讲解：越简洁越好，点到为止");
  assert.equal(lines[5], "- 常见难点：长句结构");
  assert.equal(lines[6], "- 以往反馈：「太深」偏多");
  assert.equal(lines[7], "- 老师笔记：技术词汇强于日常词汇。");
});

test("词汇量显示为估计值 ±15%，取整到百位", () => {
  const text = buildLearnerBlock({ level: { vocab: 5000, cefr: "B2" }, survey: null, stats: null, note: null });
  assert.ok(text.includes("词汇量约 4300–5800"), text);
});

test("没有的信息就省略对应行；查词不足 30 次时依据只写问卷", () => {
  const text = buildLearnerBlock({
    level: { vocab: 4000, cefr: "B1" },
    survey: { stylePref: "balanced" },
    stats: stats({ lookups: 12 }),
    note: null,
  });
  const lines = text.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes("（依据：问卷）"), lines[1]);
  assert.ok(!text.includes("身份") && !text.includes("主要阅读") && !text.includes("常见难点"));
  assert.ok(!text.includes("老师笔记") && !text.includes("以往反馈"));
});

test("没有任何信息时返回空串，不插任何内容", () => {
  assert.equal(buildLearnerBlock({ level: null, survey: null, stats: null, note: null }), "");
  assert.equal(buildLearnerBlock({ level: null, survey: {}, stats: stats(), note: "  " }), "");
});

test("「以往反馈」至少 5 次、且某一类占比超过 50% 才显示", () => {
  assert.equal(dominantFeedback({ shallow: 3, right: 1, deep: 0 }), null, "不足 5 次");
  assert.equal(dominantFeedback({ shallow: 2, right: 2, deep: 2 }), null, "6 次但没有一类过半");
  assert.equal(dominantFeedback({ shallow: 0, right: 3, deep: 3 }), null, "并列不算");
  assert.equal(dominantFeedback({ shallow: 0, right: 1, deep: 5 }), "deep");
  assert.ok(!buildLearnerBlock({ ...full, stats: stats({ feedback: { shallow: 3, right: 1, deep: 0 } }) }).includes("以往反馈"));
});

test("总长不超过 600 字符", () => {
  const huge = buildLearnerBlock({ ...full, note: "技术词汇明显强于日常词汇。".repeat(80) });
  assert.ok(huge.length <= LEARNER_BLOCK_MAX_CHARS, `实际 ${huge.length}`);
});

test("超长时先截老师笔记，再截常见难点，最后才动反馈", () => {
  const longNote = "技术词汇明显强于日常词汇。".repeat(50);
  const trimmed = buildLearnerBlock({ ...full, note: longNote });
  assert.ok(trimmed.includes("- 老师笔记："), "先截短笔记而不是直接删");
  assert.ok(trimmed.includes("常见难点") && trimmed.includes("以往反馈"), "笔记先被截，难点和反馈都还在");
  assert.ok(trimmed.length <= LEARNER_BLOCK_MAX_CHARS);

  // 固定行本身很长时，笔记会被整行丢掉，难点随后才被截
  const veryLong = buildLearnerBlock({
    ...full,
    survey: { goals: ["tech", "academic", "news", "work", "exam", "novels"] },
    stats: stats({
      lookups: 186,
      difficulties: ["long_sentence", "vocabulary", "phrases"],
      feedback: { shallow: 0, right: 1, deep: 60 },
    }),
    note: longNote,
  });
  assert.ok(veryLong.length <= LEARNER_BLOCK_MAX_CHARS, `实际 ${veryLong.length}`);
  assert.ok(veryLong.startsWith("学生档案（"));
  assert.ok(veryLong.includes("估计水平"), "主要依据不能被截掉");
});

test("前面固定行本身就超长时：补充行整行丢掉，最后硬切到 600 字符", () => {
  // 用异常长的水平字段模拟「固定行吃掉了全部预算」，验证兜底分支不会把长度放出去
  const huge = { vocab: 5000, cefr: "C".repeat(700) } as unknown as LearnerLevel;
  const out = buildLearnerBlock({
    level: huge,
    survey: { stylePref: "concise" },
    stats: stats({ difficulties: ["long_sentence"], feedback: { shallow: 0, right: 0, deep: 9 } }),
    note: "笔记".repeat(100),
  });
  assert.equal(out.length, LEARNER_BLOCK_MAX_CHARS);
  assert.ok(out.includes("估计水平"), "主要依据保留");
  assert.ok(!out.includes("老师笔记：") && !out.includes("常见难点") && !out.includes("以往反馈"),
    "补充行按 笔记 → 难点 → 反馈 的顺序让位");
});

test("有没有可依据的档案：问卷 / 查词满 30 次 / 老师笔记，任一即可；都没有 → 退回旧规则兜底", () => {
  const none = { survey: null, stats: null, note: null };
  assert.equal(hasUsableProfile(none), false);
  assert.equal(hasUsableProfile({ ...none, survey: {} }), false, "空问卷不算");
  assert.equal(hasUsableProfile({ ...none, survey: { exam: "cet6" } }), true);
  assert.equal(hasUsableProfile({ ...none, stats: stats({ lookups: 29 }) }), false, "29 次不够");
  assert.equal(hasUsableProfile({ ...none, stats: stats({ lookups: 30 }) }), true, "30 次刚好");
  assert.equal(hasUsableProfile({ ...none, note: "  " }), false, "空白笔记不算");
  assert.equal(hasUsableProfile({ ...none, note: "常卡在长句" }), true);
});

test("P34：最近的反馈放在「以往反馈」之后、「老师笔记」之前，每条一行", () => {
  const text = buildLearnerBlock({ ...full, recentFeedback: ["单词，自动讲解：约 180 字，画了句子地图 → 太深", "短语，只讲这个词 → 刚好"] });
  const lines = text.split("\n");
  const head = lines.findIndex((l) => l.startsWith("- 最近的反馈"));
  assert.ok(head > 0);
  assert.equal(lines[head + 1], "  · 单词，自动讲解：约 180 字，画了句子地图 → 太深");
  assert.equal(lines[head + 2], "  · 短语，只讲这个词 → 刚好");
  const note = lines.findIndex((l) => l.startsWith("- 老师笔记"));
  if (note >= 0) assert.ok(note > head + 2);
});

test("P34：没有最近反馈时不出现这一段；空白行被忽略", () => {
  assert.ok(!buildLearnerBlock({ ...full, recentFeedback: [] }).includes("最近的反馈"));
  assert.ok(!buildLearnerBlock({ ...full, recentFeedback: ["  "] }).includes("最近的反馈"));
});

test("P34：上限 720 字；超长时先截老师笔记，最后才从最旧的一条整行去掉最近反馈", () => {
  assert.equal(LEARNER_BLOCK_MAX_CHARS, 720);
  const recent = ["单词，自动讲解：约 180 字，画了句子地图 → 太深", "短语，只讲这个词 → 刚好", "单词，再给个例句 → 太浅"];
  const longNote = "技术词汇明显强于日常词汇。".repeat(80);
  const t = buildLearnerBlock({ ...full, note: longNote, recentFeedback: recent });
  assert.ok(t.length <= 720);
  assert.ok(recent.every((r) => t.includes(r)), "笔记截短后最近反馈完整保留");
  // 极端情况：只有大量最近反馈也超长 → 从最旧的一条（最后一行）开始整行去掉
  const huge = Array.from({ length: 3 }, (_, i) => `单词，${"很长的问题".repeat(50)}${i} → 太深`);
  const t2 = buildLearnerBlock({ level: null, survey: null, stats: null, note: null, recentFeedback: huge });
  assert.ok(t2.length <= 720);
  assert.ok(t2.includes("0 → 太深") && !t2.includes("2 → 太深"), "最旧的先去掉");
  const all = buildLearnerBlock({ level: null, survey: null, stats: null, note: null, recentFeedback: ["x".repeat(800)] });
  assert.ok(all.length <= 720 && !all.includes("最近的反馈"), "全部去光时标题也去掉");
});

test("P34 hasUsableProfile：最近 30 天反馈 ≥3 次也算有档案（2 次不算）", () => {
  const none = { survey: null, stats: null, note: null };
  assert.equal(hasUsableProfile({ ...none, recentFeedbackCount: 2 }), false);
  assert.equal(hasUsableProfile({ ...none, recentFeedbackCount: 3 }), true);
  assert.equal(hasUsableProfile({ ...none }), false);
});

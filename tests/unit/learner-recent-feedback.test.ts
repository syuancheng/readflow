import assert from "node:assert/strict";
import test from "node:test";
import {
  answerTraits,
  formatFeedbackLine,
  formatRecentFeedback,
  RECENT_FEEDBACK_DAYS,
  RECENT_FEEDBACK_FOR_PROFILE,
  RECENT_FEEDBACK_KINDS,
} from "../../src/lib/learner/recent-feedback";

const MAP_ANSWER = [
  "释义：通用的",
  "这里 generic 和 simple 并列，都是 design 的表语：设计要刻意简单、通用。",
  "🧩 主系表",
  "==主语：The design== ==系动词：should be== ==表语：deliberately simple and generic== to enable generalization.",
  "制卡建议：技术文档高频形容词",
].join("\n");

test("常量：三种评价各取一次、30 天内、3 次反馈算有档案（PRD Q5 / Q9）", () => {
  assert.deepEqual([...RECENT_FEEDBACK_KINDS], ["shallow", "right", "deep"]);
  assert.equal(RECENT_FEEDBACK_DAYS, 30);
  assert.equal(RECENT_FEEDBACK_FOR_PROFILE, 3);
});

test("answerTraits：认出句子地图；不算释义行、地图行和建议行的字数", () => {
  const t = answerTraits(MAP_ANSWER, "auto");
  assert.equal(t.hasMap, true);
  assert.equal(t.hasWholeMeaning, false);
  assert.equal(t.hasExample, false);
  // 第二行与「主系表」共约 30 个汉字 → 四舍五入到 10
  assert.equal(t.length !== null && t.length % 10 === 0 && t.length >= 20 && t.length <= 40, true, String(t.length));
});

test("answerTraits：整句大意、例句（含 askKind=example）、没有原文、只有英文", () => {
  assert.equal(answerTraits("释义：x\n整句大意：设计要简单。", "default").hasWholeMeaning, true);
  assert.equal(answerTraits("释义：x\n再给你一个例句：It is generic.", "custom").hasExample, true);
  assert.equal(answerTraits("释义：x\nOK", "example").hasExample, true);
  assert.deepEqual(answerTraits(null, "example"), { length: null, hasMap: false, hasWholeMeaning: false, hasExample: true });
  assert.deepEqual(answerTraits("   ", null), { length: null, hasMap: false, hasWholeMeaning: false, hasExample: false });
  assert.equal(answerTraits("Only English here.", null).length, 0);
  assert.equal(answerTraits("释义：一", null).length, 0, "只有释义行时篇幅为 0");
  assert.equal(answerTraits("释义：一\n短", null).length, 10, "不到 10 字按 10 字算");
});

test("formatFeedbackLine：单词 / 短语、提问种类、特征、评价；不写英文原词", () => {
  const line = formatFeedbackLine({ feedback: "deep", askKind: "auto", askLabel: null, isPhrase: false, answerText: MAP_ANSWER });
  assert.match(line, /^单词，自动讲解：约 \d+ 字，画了句子地图 → 太深$/);
  assert.ok(!/generic|design/i.test(line), "不能写出英文原词");
  const phrase = formatFeedbackLine({ feedback: "right", askKind: "default", askLabel: null, isPhrase: true, answerText: "释义：x\n整句大意：一句话概括这里的意思。再给个例句" });
  assert.match(phrase, /^短语，这个词在句里的意思：约 \d+ 字，有整句大意，给了例句 → 刚好$/);
});

test("formatFeedbackLine：有「你问」标题时优先用它并截到 12 字；没有原文只写提问种类与评价；未知种类写「讲解」", () => {
  const custom = formatFeedbackLine({ feedback: "shallow", askKind: "custom", askLabel: "这里为什么用现在完成时而不是过去时", isPhrase: false, answerText: null });
  assert.equal(custom, "单词，这里为什么用现在完成时而 → 太浅", "截到 12 个字");
  assert.equal(formatFeedbackLine({ feedback: "deep", askKind: "zzz", askLabel: "  ", isPhrase: false, answerText: null }), "单词，讲解 → 太深");
  assert.equal(formatFeedbackLine({ feedback: "odd", askKind: null, askLabel: null, isPhrase: false, answerText: null }), "单词，讲解 → odd");
});

test("formatRecentFeedback：每种评价只取最新一条，最多 3 行，从新到旧；缺某种就少一行", () => {
  const item = (feedback: string, at: number) => ({ feedback, feedbackAt: at, askKind: "auto", askLabel: null, isPhrase: false, answerText: null });
  const lines = formatRecentFeedback([item("deep", 1), item("deep", 5), item("right", 3), item("shallow", 4), item("bogus", 9)]);
  assert.deepEqual(lines, ["单词，自动讲解 → 太深", "单词，自动讲解 → 太浅", "单词，自动讲解 → 刚好"]);
  assert.deepEqual(formatRecentFeedback([item("right", 1)]), ["单词，自动讲解 → 刚好"]);
  assert.deepEqual(formatRecentFeedback([]), []);
});

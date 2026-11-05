import assert from "node:assert/strict";
import test from "node:test";
import { selectionKind, selectionSignals } from "../../src/lib/sentence";

/**
 * 选区三分类（几何信号，纯函数）：
 * - 单个词 → word
 * - 多词短语 → phrase
 * - 句子（句末标点收尾 / ≥15 词长选区）→ sentence
 *
 * 注意：新版 AI 释义不再用它决定输出模板，只作为客观证据之一。
 */
test("单词：无空白即 word", () => {
  assert.equal(selectionKind("prompt"), "word");
  assert.equal(selectionKind("  Prompt  "), "word"); // 首尾空白不算词间空格
  assert.equal(selectionKind("don't"), "word");
  assert.equal(selectionKind(""), "word"); // 空选区兜底按单词处理
});

test("短语：多词、无句末标点、不足长句", () => {
  assert.equal(selectionKind("prompt engineering"), "phrase");
  assert.equal(selectionKind("In-Context Prompting"), "phrase");
  assert.equal(selectionKind("refers to methods for how to communicate"), "phrase");
});

test("句子：以句末标点收尾（引号/括号可跟在后面）", () => {
  assert.equal(
    selectionKind("This post only focuses on prompt engineering."),
    "sentence",
  );
  assert.equal(selectionKind("What does steerable mean?"), "sentence");
  assert.equal(selectionKind('He called it "prompt engineering."'), "sentence");
  assert.equal(selectionKind("(see the previous post!)"), "sentence");
  assert.equal(selectionKind("tricks can be explained…"), "sentence");
});

test("长选区兜底：≥15 词无标点也按句子处理", () => {
  const longClause = Array.from({ length: 15 }, (_, i) => `word${i}`).join(" ");
  assert.equal(selectionKind(longClause), "sentence");
  // 14 词仍是短语
  assert.equal(selectionKind(longClause.split(" ").slice(0, 14).join(" ")), "phrase");
});

test("短语里带缩写点不算句子（e.g. / etc. 不在句尾即可）", () => {
  assert.equal(selectionKind("methods for e.g. cloze tests"), "phrase");
});

const PARA =
  "The opposite problem is the classifier repeatedly stopping something that's routine in your setup.";

/** 阅读器采集的客观信号，随释义请求送给模型（不是结论） */
test("selectionSignals：单词选区给出所在句原文、词数与覆盖率", () => {
  const s = PARA.indexOf("classifier");
  const sig = selectionSignals(PARA, s, s + "classifier".length, "word");
  assert.equal(sig.source, "word");
  assert.equal(sig.selectionWords, 1);
  assert.equal(sig.sentence.trim(), PARA.trim(), "所在句必须是完整句子，供句子地图标注");
  assert.equal(sig.sentenceWords, sig.sentence.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length);
  assert.ok(sig.coverage > 0 && sig.coverage < 1);
  assert.ok(["start", "middle", "end"].includes(sig.position));
});

test("selectionSignals：拖选短语与点词只是 source 不同，其余证据同构", () => {
  const s = PARA.indexOf("repeatedly stopping");
  const phrase = selectionSignals(PARA, s, s + "repeatedly stopping".length, "select");
  const word = selectionSignals(PARA, s, s + "repeatedly".length, "word");
  assert.equal(phrase.source, "select");
  assert.equal(word.source, "word");
  assert.equal(phrase.selectionWords, 2);
  assert.equal(word.selectionWords, 1);
  assert.equal(phrase.sentence, word.sentence, "同句内不同选区，句子原文应完全一致");
  assert.ok(phrase.coverage > word.coverage);
});

test("selectionSignals：跨句选区合并句子区间，不丢上下文", () => {
  const two = "First sentence ends here. Second sentence starts now.";
  const sig = selectionSignals(two, 18, 40, "select");
  assert.ok(sig.sentence.includes("First") && sig.sentence.includes("Second"));
  assert.ok(sig.sentenceWords >= 7);
  assert.ok(sig.sentenceStart <= 18 && sig.sentenceEnd >= 40);
});

test("selectionSignals：位置是粗证据，句首/句末可区分", () => {
  assert.equal(selectionSignals(PARA, 0, 3, "word").position, "start");
  assert.equal(selectionSignals(PARA, PARA.length - 8, PARA.length, "select").position, "end");
});

test("selectionSignals：确定性纯函数，越界与空段落不崩", () => {
  const a = selectionSignals(PARA, 10, 30, "select");
  const b = selectionSignals(PARA, 10, 30, "select");
  assert.deepEqual(a, b, "同样的输入必须给出完全同样的输出（不依赖 ICU 随机性）");
  const empty = selectionSignals("", 0, 5, "word");
  assert.equal(empty.selectionWords, 0);
  assert.equal(empty.sentence, "");
  assert.ok(empty.coverage >= 0 && empty.coverage <= 1);
});

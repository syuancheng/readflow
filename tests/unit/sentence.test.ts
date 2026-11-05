import assert from "node:assert/strict";
import test from "node:test";
import { selectionKind } from "../../src/lib/sentence";

/**
 * 选区三分类（决定 AI 释义模板）：
 * - 单个词 → word（「通常意思 → 在这里的意思 → 其他用法」）
 * - 多词短语 → phrase（同一结构）
 * - 句子（句末标点收尾 / ≥15 词长选区）→ sentence
 *   （「翻译 → 结合语境的解释 → 主谓宾分析」，主谓宾必填）
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

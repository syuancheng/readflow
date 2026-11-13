import assert from "node:assert/strict";
import test from "node:test";
import { splitCardSuggestion, SUGGESTION_REASON_HINT } from "../../src/lib/cards/suggestion";

test("末行是建议 → 拆出正文和理由", () => {
  const r = splitCardSuggestion("释义：短暂的\n解释。\n制卡建议：正好在你词汇量的边缘");
  assert.equal(r.body, "释义：短暂的\n解释。");
  assert.equal(r.suggestion, "正好在你词汇量的边缘");
});

test("空输入 / 没有建议 → 原样返回", () => {
  assert.deepEqual(splitCardSuggestion(""), { body: "", suggestion: null });
  assert.deepEqual(splitCardSuggestion(null), { body: "", suggestion: null });
  assert.deepEqual(splitCardSuggestion(undefined), { body: "", suggestion: null });
  assert.deepEqual(splitCardSuggestion("   \n \n"), { body: "", suggestion: null });
  assert.deepEqual(splitCardSuggestion("只是讲解。\n"), { body: "只是讲解。", suggestion: null });
});

test("建议行后面有空行 / 空白也能识别", () => {
  const r = splitCardSuggestion("正文\n制卡建议：理由\n\n  \n");
  assert.equal(r.body, "正文");
  assert.equal(r.suggestion, "理由");
});

test("建议行在中间不算（后面还有正文）", () => {
  const t = "正文\n制卡建议：理由\n还有一段";
  assert.deepEqual(splitCardSuggestion(t), { body: t, suggestion: null });
});

test("多行都带前缀：只取最后一行，前面的留在正文里", () => {
  const r = splitCardSuggestion("制卡建议：第一条\n制卡建议：第二条");
  assert.equal(r.suggestion, "第二条");
  assert.equal(r.body, "制卡建议：第一条");
});

test("只有建议行：正文为空串", () => {
  assert.deepEqual(splitCardSuggestion("制卡建议：理由"), { body: "", suggestion: "理由" });
});

test("前缀后没有内容 → 不当建议，正文保留", () => {
  assert.deepEqual(splitCardSuggestion("正文\n制卡建议：  "), { body: "正文\n制卡建议：", suggestion: null });
});

test("理由超过 30 字也完整返回，不截断、不加省略号（截断会让人看不懂）", () => {
  assert.equal(SUGGESTION_REASON_HINT, 30, "30 字只是写给模型的建议");
  const exact = "字".repeat(30);
  assert.equal(splitCardSuggestion(`x\n制卡建议：${exact}`).suggestion, exact);
  const long = "技术文档高频形容词，与 generalization 同源，值得放在一起记，别和名词混了";
  assert.ok(Array.from(long).length > 30);
  const r = splitCardSuggestion(`正文\n制卡建议：${long}`);
  assert.equal(r.suggestion, long);
  assert.ok(!r.suggestion?.includes("…"));
  assert.equal(r.body, "正文");
});

test("CRLF 换行也能识别", () => {
  assert.equal(splitCardSuggestion("正文\r\n制卡建议：理由").suggestion, "理由");
});

test("半角冒号不识别（约定用全角）", () => {
  const t = "正文\n制卡建议: 理由";
  assert.deepEqual(splitCardSuggestion(t), { body: t, suggestion: null });
});

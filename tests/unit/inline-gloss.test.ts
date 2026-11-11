/**
 * P23 行内中文标签的短释义裁剪。
 *
 * 契约：标签是 CSS 伪元素生成的、不进 DOM 文本节点；所以它必须**短且确定性**，
 * 不能把半句解释挂到正文上。AI 释义形态不稳定时宁可回退词典义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineGloss } from "../../src/lib/gloss";
import { NO_MODEL_NOTICE } from "../../src/lib/explain-policy";

test("词典义：去词性前缀，只取第一个义项", () => {
  assert.equal(inlineGloss(null, "v. 失控增长；失去控制"), "失控增长");
  assert.equal(inlineGloss(null, "n. 观念, 概念"), "观念");
  assert.equal(inlineGloss(null, "adj. 一丝不苟的"), "一丝不苟的");
});

test("词典义：学科标签与字面量换行不进标签", () => {
  assert.equal(inlineGloss(null, "[医] 概念\\n[计] 概念"), "概念");
  assert.equal(inlineGloss(null, "n. 观念, 概念\\n[医] 概念"), "观念");
});

test("AI 语境义优先于词典义，行首「」直接取引号内容", () => {
  assert.equal(
    inlineGloss("「失控增长」——在这里形容系统规模，不是形容人。", "v. 增长；扩大"),
    "失控增长",
  );
});

test("AI 第一屏是解释性长句时回退词典义，不把半句话挂到正文上", () => {
  const long = "这里的 stopping 不是「停止一次」，而是分类器反复把操作拦下来；所以整句在说误报变多了。";
  assert.equal(inlineGloss(long, "v. 停止"), "停止");
});

test("降级文案 / 报错文案不是释义，回退词典义或返回空", () => {
  assert.equal(inlineGloss(NO_MODEL_NOTICE, "n. 测试"), "测试");
  assert.equal(inlineGloss("[Error: timeout]", null), "");
  assert.equal(inlineGloss(NO_MODEL_NOTICE, null), "");
});

test("超长释义按字符截断，中文不被切成半个字", () => {
  const out = inlineGloss(null, "n. 一个非常非常非常长的中文释义片段", 6);
  assert.ok(Array.from(out).length <= 7, `实际 ${out}`);
  assert.ok(out.endsWith("…"));
});

test("空值安全，Markdown 强调记号不残留", () => {
  assert.equal(inlineGloss(null, null), "");
  assert.equal(inlineGloss("", ""), "");
  assert.equal(inlineGloss(null, "**n.** 观念"), "观念");
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildSummaryPrompt, buildSystemPrompt } from "../../src/lib/ai";

/**
 * AI 释义输出结构（用户 2026-11-05 指定）：
 * - 单词/短语：通常意思 → 在这里的意思 → 其他用法，且顺序不可颠倒
 * - 句子：翻译 → 结合语境的解释 → 主谓宾分析（必填、殿后，备考雅思/托福）
 */
test("单词模板：通常意思在前，语境意思次之，其他用法收尾", () => {
  const p = buildSystemPrompt("en", false, "steer");
  const order = ["**通常意思**", "**在这里的意思**", "**其他用法**"].map((h) => p.indexOf(h));
  assert.ok(order.every((i) => i > 0), "三个小标题都应存在");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "小标题顺序必须固定");
  assert.ok(!p.includes("主谓宾"), "单词模板不需要句子成分分析");
  assert.ok(p.includes("不要输出音标"), "必须明确禁止输出音标");
});

test("短语模板：与单词同构，措辞为「这个短语」", () => {
  const p = buildSystemPrompt("en", false, "prompt engineering");
  assert.ok(p.includes("划选了一个短语"));
  assert.ok(p.includes("**通常意思**") && p.includes("**其他用法**"));
  assert.ok(p.includes("这个短语最常见的整体含义"));
});

test("句子模板：翻译置顶，主谓宾分析殿后且不可省略", () => {
  const p = buildSystemPrompt("en", false, "This post only focuses on prompt engineering.");
  const order = ["**翻译**", "**结合语境的解释**", "**主谓宾分析**"].map((h) => p.indexOf(h));
  assert.ok(order.every((i) => i > 0), "三个小标题都应存在");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "翻译必须最先、主谓宾必须最后");
  assert.ok(p.includes("不可省略") || p.includes("绝不能省略"), "主谓宾分析必须标注为必填");
  assert.ok(p.includes("主语") && p.includes("谓语动词"), "必须明确要求找主语与谓语动词");
});

test("英文自解释模式同样带主谓宾分析要求", () => {
  const p = buildSystemPrompt("en", true, "This post only focuses on prompt engineering.");
  assert.ok(/subject[–-]verb[–-]object analysis/i.test(p));
  assert.ok(p.toLowerCase().includes("mandatory"));
});

/**
 * 分段小结（用户 2026-11-05）：就是一段 summary，概括这一部分讲了什么，
 * 不做论证分析、不逐句翻译、不分点、不加「总结：」前缀。
 */
test("小结模板：短、纯 summary，不掺论证分析与分点", () => {
  const p = buildSummaryPrompt();
  assert.ok(p.includes("2~3 句话"), "长度要求必须明确");
  assert.ok(p.includes("120 字"), "字数上限必须明确");
  assert.ok(p.includes("不分点"), "不允许分点罗列");
  assert.ok(p.includes("不写「总结：」") || p.includes("不写「总结"), "禁止加前缀");
  assert.ok(!p.includes("主谓宾"), "小结不做句子成分分析");
  assert.ok(!p.includes("**"), "小结不使用 Markdown 小标题");
});

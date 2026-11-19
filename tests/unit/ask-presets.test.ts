import assert from "node:assert/strict";
import test from "node:test";
import { buildAskPresets } from "../../src/lib/ask-presets";

const base = { isPhrase: false, isWholeSentence: false, hasDefault: false, quote: "vigorously", sentence: "A b c." };
const labels = (o: Partial<typeof base>) => buildAskPresets({ ...base, ...o }).map((p) => p.label);

test("没有首次讲解：第一项是「这个词在这句里什么意思」", () => {
  assert.deepEqual(labels({}), ["这个词在这句里什么意思", "整句没看懂", "讲讲句子结构", "再给个例句", "从内容角度讲讲"]);
});

test("选中的是短语：第一项改成「这个短语…」", () => {
  assert.equal(labels({ isPhrase: true })[0], "这个短语在这句里什么意思");
});

test("已有首次讲解：不再出现第一项", () => {
  assert.deepEqual(labels({ hasDefault: true }), ["整句没看懂", "讲讲句子结构", "再给个例句", "从内容角度讲讲"]);
});

test("选中的就是整句：隐藏「整句没看懂」", () => {
  assert.ok(!labels({ isWholeSentence: true }).includes("整句没看懂"));
});

test("整句没看懂 / 从内容角度讲讲 走整句模式，带整句原文", () => {
  const list = buildAskPresets({ ...base, hasDefault: true });
  const whole = list.find((p) => p.key === "whole_sentence")!;
  const domain = list.find((p) => p.key === "domain")!;
  for (const p of [whole, domain]) {
    assert.equal(p.req.wholeSentence, true);
    assert.equal(p.req.word, "A b c.");
  }
  assert.equal(whole.req.askKind, "whole_sentence");
  assert.equal(domain.req.askKind, "domain");
});

test("结构 / 例句的提示词带上选中的词，不走整句模式", () => {
  const list = buildAskPresets({ ...base, hasDefault: true, quote: "fulling" });
  const structure = list.find((p) => p.key === "structure")!;
  const example = list.find((p) => p.key === "example")!;
  assert.match(structure.req.prompt!, /「fulling」/);
  assert.match(example.req.prompt!, /「fulling」/);
  assert.equal(structure.req.wholeSentence, undefined);
  assert.equal(example.req.askKind, "example");
});

test("首次讲解的请求没有 ask 标题，askKind 是 default", () => {
  const first = buildAskPresets(base)[0];
  assert.deepEqual(first.req, { askKind: "default" });
});

test("提示词文本与搬运前逐字一致", () => {
  const list = buildAskPresets({ ...base, hasDefault: true });
  assert.equal(
    list.find((p) => p.key === "whole_sentence")!.req.prompt,
    "这句话里的词我基本都认识，但整句没看懂。第一行按「释义：」格式给出整句的中文翻译；然后用一两行点明这句难在哪里（结构、指代、搭配或背景知识），帮我下次自己能拆开；必要时再给句子地图。",
  );
  assert.equal(
    list.find((p) => p.key === "domain")!.req.prompt,
    "这句话我已经知道中文意思了。请先跳出英语学习本身，从这篇文章讲的内容出发，讲讲这句话涉及的概念、做法或设计取舍，以及作者为什么这么写、它在文章的论证里起什么作用。",
  );
});

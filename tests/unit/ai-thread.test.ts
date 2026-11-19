/**
 * P26 右栏 AI 对话串：新回答追加在下面、整串存进一条 ai_gloss、回看原样还原；
 * 行内中文 / 卡片背面只从默认讲解那一段取。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultTurnText, parseThread, serializeThread } from "../../src/lib/ai-thread";
import { attachAnswers } from "../../src/lib/ai-thread";
import { cardGloss, inlineGloss } from "../../src/lib/gloss";

test("往返：默认讲解 + 两次追问，存进去再读出来一字不差", () => {
  const turns = [
    { text: "释义：超智能的\nultra- 是「超出」。" },
    { ask: "整句没看懂", text: "释义：他把超智能机器定义为……\n卡点在 defined A as B。" },
    { ask: "再给个例句", text: "An ultraintelligent system could …" },
  ];
  const raw = serializeThread(turns);
  assert.deepEqual(parseThread(raw), turns);
});

test("引用片段随追问往返保存：划选的原话在回看时仍在", () => {
  const turns = [
    { text: "释义：超智能的" },
    { ask: "它的作用是什么", quote: "when 引导时间状语从句", text: "when 是从属连词……" },
  ];
  const raw = serializeThread(turns);
  assert.ok(raw.includes("【引用】when 引导时间状语从句"));
  assert.deepEqual(parseThread(raw), turns);
});

test("引用里的换行压成一行；没有引用的追问不受影响", () => {
  const raw = serializeThread([
    { ask: "这句", quote: "第一行\n第二行", text: "答" },
    { ask: "普通追问", text: "答2" },
  ]);
  assert.ok(raw.includes("【引用】第一行 第二行"));
  const back = parseThread(raw);
  assert.equal(back[0].quote, "第一行 第二行");
  assert.equal(back[1].quote, undefined, "没有引用的追问不凭空多出 quote 字段");
  assert.equal(back[0].text, "答", "引用行不混进回答正文");
  // 这条串第一turn就是追问，本来就没有默认讲解
  assert.equal(defaultTurnText(raw), "");
});

test("旧记录（没有追问标记）就是一段默认讲解", () => {
  assert.deepEqual(parseThread("「弱点挖掘」——指找出薄弱环节。"), [{ text: "「弱点挖掘」——指找出薄弱环节。" }]);
  assert.deepEqual(parseThread(""), []);
  assert.deepEqual(parseThread(null), []);
});

test("词典查到、直接问了「整句没看懂」：整串从追问开始，没有默认讲解", () => {
  const raw = serializeThread([{ ask: "整句没看懂", text: "释义：他把超智能机器定义为……" }]);
  assert.ok(raw.startsWith("【追问】整句没看懂"));
  assert.equal(defaultTurnText(raw), "");
  // 行内中文回退词典义，不会把整句翻译挂到词上面
  assert.equal(inlineGloss(raw, "a. 超智能的"), "超智能的");
});

test("行内中文和卡片背面只取默认讲解，追问的「释义：」行不算", () => {
  const raw = serializeThread([
    { text: "释义：超智能的\n解释……" },
    { ask: "整句没看懂", text: "释义：他把一种比人更聪明的机器定义为能超越人类的系统" },
  ]);
  assert.equal(inlineGloss(raw, null), "超智能的");
  assert.equal(cardGloss(raw), "超智能的");
});

test("空回答不入串", () => {
  assert.equal(serializeThread([{ text: "释义：甲" }, { ask: "例句", text: "   " }]), "释义：甲");
});

test("P34 attachAnswers：按顺序给每段对上回答；新老混合；同文两段各配一个；没有回答；回答比段多", () => {
  const turns = [{ text: "释义：a\n讲解一" }, { ask: "再给个例句", text: "例句" }, { ask: "再给个例句", text: "例句" }];
  const answers = [
    { answerId: "x1", text: "  释义：a\n讲解一  ", feedback: "deep" },
    { answerId: "x2", text: "例句", feedback: null },
    { answerId: "x3", text: "例句", feedback: "right" },
    { answerId: "x4", text: "多出来的", feedback: null },
  ];
  const r = attachAnswers(turns, answers);
  assert.deepEqual(r.map((t) => [t.answerId, t.feedback]), [["x1", "deep"], ["x2", null], ["x3", "right"]]);
  const legacy = attachAnswers([{ text: "老讲解" }, { ask: "q", text: "例句" }], [{ answerId: "y", text: "例句", feedback: "shallow" }]);
  assert.deepEqual(legacy.map((t) => t.answerId), [undefined, "y"]);
  assert.deepEqual(attachAnswers(turns, []).map((t) => t.answerId), [undefined, undefined, undefined]);
  assert.equal(r[1].ask, "再给个例句", "原有字段保留");
});

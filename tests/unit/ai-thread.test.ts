/**
 * P26 右栏 AI 对话串：新回答追加在下面、整串存进一条 ai_gloss、回看原样还原；
 * 行内中文 / 卡片背面只从默认讲解那一段取。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultTurnText, parseThread, serializeThread } from "../../src/lib/ai-thread";
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

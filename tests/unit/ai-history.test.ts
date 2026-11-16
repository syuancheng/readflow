import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDomainSystemPrompt,
  buildSystemPrompt,
  buildUserMessage,
  EXPLAIN_HISTORY_MAX_CHARS,
  EXPLAIN_HISTORY_MAX_TURNS,
  explainTurns,
  historyTurns,
  narrowHistory,
} from "../../src/lib/ai";

/**
 * 真正的多轮追问（2026-11-16）：同一批注内，模型要能看到之前问过什么、答过什么。
 * 核心性质：不带 history 时消息结构与逐字内容必须与旧版完全一致。
 */
const BASE = {
  word: "which goes a lot",
  context: "change that goes a lot deeper than convincing yourself.",
  prefix: "true ",
  suffix: " deeper than convincing yourself.",
  cardsEnabled: false,
};

test("无历史：explainTurns 就是原来的 system + user 两条，逐字不变", () => {
  const turns = explainTurns(BASE);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "system");
  assert.equal(turns[0].content, buildSystemPrompt("en", false, BASE.word, { cardsEnabled: false }));
  assert.equal(turns[1].role, "user");
  assert.equal(turns[1].content, buildUserMessage(BASE));
  // 显式空数组也一样
  assert.deepEqual(explainTurns({ ...BASE, history: [] }), turns);
});

test("historyTurns：一轮问答 = 一条 user + 一条 assistant，按原顺序", () => {
  const out = historyTurns([
    { text: "第一次回答：这里的 which 指 true change" },
    { ask: "其实我没理解的是 goes a lot", text: "第二次回答：a lot 修饰 deeper" },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "学生没有说出具体问题，请我判断他卡在哪里。" },
    { role: "assistant", content: "第一次回答：这里的 which 指 true change" },
    { role: "user", content: "学生的问题: 其实我没理解的是 goes a lot" },
    { role: "assistant", content: "第二次回答：a lot 修饰 deeper" },
  ]);
});

test("explainTurns：历史夹在 system 与本轮 user 之间，本轮 user 永远在最后", () => {
  const turns = explainTurns({
    ...BASE,
    prompt: "那它和 goes deeper 有什么区别？",
    history: [{ ask: "goes a lot 什么意思", text: "表示深入得多" }],
  });
  assert.equal(turns[0].role, "system");
  assert.deepEqual(turns.slice(1, 3), [
    { role: "user", content: "学生的问题: goes a lot 什么意思" },
    { role: "assistant", content: "表示深入得多" },
  ]);
  assert.equal(turns[turns.length - 1].role, "user");
  assert.ok(turns[turns.length - 1].content.includes("学生的问题: 那它和 goes deeper 有什么区别？"));
});

test("领域追问仍是领域人设，历史照带", () => {
  const turns = explainTurns({
    ...BASE,
    askKind: "domain",
    history: [{ text: "上一次回答" }],
  });
  assert.equal(turns[0].content, buildDomainSystemPrompt());
  assert.ok(turns.some((t) => t.role === "assistant" && t.content === "上一次回答"));
});

test("历史截断：最多 MAX_TURNS 轮，单轮回答最多 MAX_CHARS 字；空文本轮次丢弃", () => {
  const many = Array.from({ length: EXPLAIN_HISTORY_MAX_TURNS + 5 }, (_, i) => ({
    ask: `问题${i}`,
    text: `回答${i}`,
  }));
  const out = historyTurns(many);
  assert.equal(out.length, EXPLAIN_HISTORY_MAX_TURNS * 2, "只保留最近的上限轮数");
  assert.equal(out[0].content, `学生的问题: 问题5`, "丢掉最早的，保留最近的");

  const long = historyTurns([{ text: "字".repeat(EXPLAIN_HISTORY_MAX_CHARS + 500) }]);
  assert.equal(long[1].content.length, EXPLAIN_HISTORY_MAX_CHARS);

  assert.deepEqual(historyTurns([{ text: "   " }, { ask: "问", text: "" }]), []);
  assert.deepEqual(historyTurns(undefined), []);
});

test("服务端白名单 narrowHistory：只取 {ask?,text}，丢额外字段、裁字数、限量", () => {
  const cleaned = narrowHistory([
    { ask: " 为什么 ", text: "  回答 ", role: "assistant", injected: "x" },
    { text: 123 },
    { ask: "无回答" },
    null,
    "字符串",
  ]);
  assert.deepEqual(cleaned, [{ ask: "为什么", text: "回答" }], "非法轮次整条丢弃，额外字段不透传");

  const many = Array.from({ length: EXPLAIN_HISTORY_MAX_TURNS + 4 }, (_, i) => ({ text: `r${i}` }));
  const limited = narrowHistory(many);
  assert.equal(limited?.length, EXPLAIN_HISTORY_MAX_TURNS);
  assert.equal(limited?.[0].text, "r4", "保留最近的轮次");

  const long = narrowHistory([{ text: "x".repeat(EXPLAIN_HISTORY_MAX_CHARS + 100) }]);
  assert.equal(long?.[0].text.length, EXPLAIN_HISTORY_MAX_CHARS);
  const longAsk = narrowHistory([{ ask: "问".repeat(80), text: "答" }]);
  assert.equal(longAsk?.[0].ask?.length, 60, "问题标题裁到 60 字");

  assert.equal(narrowHistory(undefined), undefined);
  assert.equal(narrowHistory([]), undefined);
  assert.equal(narrowHistory({ not: "array" }), undefined);
});

test("历史不进本轮 user 消息：contextBlock 与问题行逐字不变", () => {
  const without = buildUserMessage({ ...BASE, prompt: "为什么？" });
  const withHistory = buildUserMessage({
    ...BASE,
    prompt: "为什么？",
    history: [{ ask: "上一个问题", text: "上一回答" }],
  });
  assert.equal(withHistory, without, "历史只走 messages，不塞进本轮 user 文本");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDomainSystemPrompt,
  buildSentenceStructureMethodPrompt,
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

/* P44：「讲讲句子结构」这一轮的拆句方法 */
test("structure 轮次：人设不变，方法提示作为第二条 system 注入", () => {
  const turns = explainTurns({ ...BASE, askKind: "structure" });
  assert.equal(turns.length, 3);
  assert.equal(turns[0].role, "system");
  assert.equal(turns[0].content, buildSystemPrompt("en", false, BASE.word, { cardsEnabled: false }));
  assert.equal(turns[1].role, "system");
  assert.equal(turns[1].content, buildSentenceStructureMethodPrompt());
  assert.equal(turns[2].role, "user");
  assert.equal(turns[2].content, buildUserMessage({ ...BASE, askKind: "structure" }));
});

test("方法提示含三步与找谓语锚点，且不要求整句翻译", () => {
  const m = buildSentenceStructureMethodPrompt();
  for (const s of ["谓语动词", "标点", "that", "插入成分", "Were / Had / Should", "if 从句"]) {
    assert.ok(m.includes(s), `方法提示缺少「${s}」`);
  }
  // 学生的硬要求：先挪一边再回来，不是直接扔；不给逐字整句翻译
  assert.ok(m.includes("抓完主干再回来看"));
  assert.ok(m.includes("不是整句逐字翻译"));
  // 不能写成给学生的编号步骤清单
  assert.ok(m.includes("不要把这些步骤写成编号说明念给他"));
});

test("控制变量：其他 askKind 与默认讲解都不含方法提示，逐字不变", () => {
  const plain = explainTurns(BASE);
  for (const kind of ["auto", "default", "word_only", "whole_sentence", "example", "domain", "custom"]) {
    const turns = explainTurns({ ...BASE, askKind: kind });
    assert.equal(turns.length, plain.length, `${kind} 消息条数不应变化`);
    assert.ok(
      !turns.some((t) => t.role === "system" && t.content.includes("这一轮：带学生拆开这个长句")),
      `${kind} 不应注入拆句方法`,
    );
  }
  assert.deepEqual(explainTurns({ ...BASE, askKind: "structure" }).slice(2), plain.slice(1));
});

test("structure 轮次：学生硬规则仍在方法提示之后，优先级更高", () => {
  const turns = explainTurns({
    ...BASE,
    askKind: "structure",
    teachingRules: "学生本人明确写下的讲解要求，优先于其它讲解偏好，必须遵守；回答里不要提到这些要求。\n学生不希望老师做的：\n- 不要给整句翻译",
  });
  assert.equal(turns.length, 4);
  assert.equal(turns[0].role, "system");
  assert.equal(turns[1].content, buildSentenceStructureMethodPrompt());
  assert.ok(turns[2].content.includes("学生本人明确写下的讲解要求"));
  assert.ok(turns[2].content.indexOf("不要给整句翻译") > -1);
  assert.equal(turns[3].role, "user");
});

test("structure 轮次带历史：方法在人设之后、规则之前，本轮 user 在最后", () => {
  const turns = explainTurns({
    ...BASE,
    askKind: "structure",
    prompt: "讲讲这句话的结构",
    teachingRules: "学生规则",
    history: [{ text: "上一次回答" }],
  });
  assert.deepEqual(
    turns.map((t) => t.role),
    ["system", "system", "system", "user", "assistant", "user"],
  );
  assert.equal(turns[1].content, buildSentenceStructureMethodPrompt());
  assert.equal(turns[2].content, "学生规则");
  assert.equal(turns[turns.length - 1].role, "user");
  assert.ok(turns[turns.length - 1].content.includes("学生的问题: 讲讲这句话的结构"));
});

test("历史压缩（P45）：首次讲解一直保留，最近 3 轮完整，中间压成要点；空文本轮次丢弃", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    ...(i === 0 ? {} : { ask: `问题${i}` }),
    text: `回答${i}\n` + "字".repeat(300),
  }));
  const out = historyTurns(many);
  assert.equal(out.length, 20, "10 轮都在（没超预算，没有整轮丢掉）");
  assert.ok(out[1].content.startsWith("回答0"), "首次讲解排第一、完整");
  assert.equal(out[1].content.length, 304, "首次讲解没被压缩");
  assert.ok(out[3].content.startsWith("[要点] 回答1"), "中间的轮次是要点");
  assert.ok(out[3].content.length < 320, "要点很短");
  assert.ok(out[19].content.startsWith("回答9") && out[19].content.length === 304, "最近几轮完整");

  const long = historyTurns([{ text: "字".repeat(EXPLAIN_HISTORY_MAX_CHARS + 500) }]);
  assert.equal(long[1].content.length, 2000, "单条回答最多 2000 字（从中间截）");

  assert.deepEqual(historyTurns([{ text: "   " }, { ask: "问", text: "" }]), []);
  assert.deepEqual(historyTurns(undefined), []);
});

test("历史压缩：超预算时丢掉最早的要点，并在开头说明省略了几轮", () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ ask: `问题${i}`, text: "回答。".repeat(900) }));
  const out = historyTurns(big);
  assert.equal(out[0].role, "system");
  assert.match(out[0].content, /更早的 \d+ 轮对话已省略/);
  assert.ok(out[1].content.startsWith("学生没有说出具体问题") || out[1].content.startsWith("学生的问题: 问题0"), "首次讲解仍在最前");
  assert.equal(out.at(-1)?.role, "assistant");
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

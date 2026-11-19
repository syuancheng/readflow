import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextLayersSystemMessage,
  buildDomainSystemPrompt,
  buildSentenceStructureMethodPrompt,
  buildSystemPrompt,
  buildUserMessage,
  CONTEXT_LAYER_NEAR_MAX_CHARS,
  CONTEXT_LAYER_SENTENCE_MAX_CHARS,
  EXPLAIN_HISTORY_MAX_CHARS,
  EXPLAIN_HISTORY_MAX_TURNS,
  EXPLAIN_QUOTE_MAX_CHARS,
  explainTurns,
  historyTurns,
  narrowContextLayers,
  narrowHistory,
  narrowQuote,
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

/** 划选 AI 回答里的片段追问：引用要明确告诉模型那是它自己的原话 */
test("引用片段：无引用逐字不变；有引用明确标注是模型自己的原话", () => {
  const without = buildUserMessage({ ...BASE, prompt: "这段什么意思" });
  assert.ok(!without.includes("你引用了自己"), "无引用时不插入任何字符");

  const withQuote = buildUserMessage({
    ...BASE,
    prompt: "这段什么意思",
    quote: { text: "up 和 to 分属两个成分", turnIndex: 1 },
  });
  assert.ok(withQuote.includes("你引用了自己上一条回答里的这段话"));
  assert.ok(withQuote.includes("「up 和 to 分属两个成分」"));
  assert.ok(withQuote.indexOf("你引用了自己") < withQuote.indexOf("学生的问题: 这段什么意思"),
    "引用要放在问题行之前");

  // 引用与历史并存：两者都在，互不覆盖
  const both = buildUserMessage({
    ...BASE,
    prompt: "再讲讲",
    history: [{ text: "上次回答" }],
    quote: { text: "引用原文", turnIndex: 0 },
  });
  assert.ok(both.includes("「引用原文」") && both.includes("学生的问题: 再讲讲"));
});

test("narrowQuote 白名单：裁剪字数、只收合法结构，非法输入丢弃", () => {
  assert.deepEqual(
    narrowQuote({ text: "  一段话  ", turnIndex: 2, evil: "x" }),
    { text: "一段话", turnIndex: 2 },
    "额外字段不透传",
  );
  const long = narrowQuote({ text: "字".repeat(EXPLAIN_QUOTE_MAX_CHARS + 100), turnIndex: 0 });
  assert.equal(long?.text.length, EXPLAIN_QUOTE_MAX_CHARS);
  assert.deepEqual(narrowQuote({ text: "   " }), undefined, "空引用丢弃");
  assert.deepEqual(narrowQuote({ text: 123 }), undefined);
  assert.deepEqual(narrowQuote(null), undefined);
  assert.deepEqual(narrowQuote("字符串"), undefined);
  // turnIndex 非法归 0，不超过 99
  assert.deepEqual(narrowQuote({ text: "x", turnIndex: -1 }), { text: "x", turnIndex: 0 });
  assert.deepEqual(narrowQuote({ text: "x", turnIndex: "1" }), { text: "x", turnIndex: 0 });
  assert.equal(narrowQuote({ text: "x", turnIndex: 999 })?.turnIndex, 99);
});

// ====== 两层上下文：system 位置、分层说明、缓存稳定性（2026-11-19）======

const LAYERS = {
  sentence: "Man: Get the plain one.",
  nearContext: [
    "Woman: That could work.",
    "Man: The bakery has banana bread.",
    "Woman: So I was thinking a loaf cake.",
  ],
};

test("两层上下文：作为独立 system 插在规则之后、历史之前，本轮 user 仍在最后", () => {
  const turns = explainTurns({
    ...BASE,
    contextLayers: LAYERS,
    teachingRules: "别直接给整句翻译",
    history: [{ ask: "plain 什么意思", text: "plain = 普通的" }],
  });
  const systems = turns.filter((t) => t.role === "system").map((t) => t.content);
  assert.equal(systems.length, 3, "人设 + 规则 + 两层上下文，共三条 system");
  assert.deepEqual(systems.slice(0, 2), [
    buildSystemPrompt("en", false, BASE.word, { cardsEnabled: false }),
    "别直接给整句翻译",
  ]);
  assert.ok(systems[2].includes("两处不同，别混用"));
  // 顺序：system ×3 → 历史 user/assistant → 本轮 user
  assert.equal(turns[3].role, "user");
  assert.equal(turns[3].content, "学生的问题: plain 什么意思");
  assert.equal(turns[4].role, "assistant");
  assert.equal(turns[turns.length - 1].role, "user");
  assert.equal(turns[turns.length - 1].content, buildUserMessage({ ...BASE, contextLayers: LAYERS }));
});

test("分层提示词：讲清所在句是对象、近前文是背景，且不要翻译背景", () => {
  const msg = buildContextLayersSystemMessage(LAYERS);
  assert.ok(msg.includes("所在句") && msg.includes("讲的对象"));
  assert.ok(msg.includes("近前文") && msg.includes("背景"));
  assert.ok(msg.includes("不要把它逐字译成中文"));
  // 两层内容都在，且倒序呈现
  assert.ok(msg.indexOf("That could work") < msg.indexOf("loaf cake"));
  assert.ok(msg.includes('"Man: Get the plain one."'));
});

test("两层上下文：user 消息不再重复所在句与前后文，只留选中项", () => {
  const msg = buildUserMessage({ ...BASE, contextLayers: LAYERS });
  assert.ok(msg.includes('用户选中: "which goes a lot"'));
  assert.ok(!msg.includes("前文:"), "旧的前文行不再出现");
  assert.ok(!msg.includes("后文:"), "旧的后文行不再出现");
  assert.ok(!msg.includes("所在句子:"), "所在句已移到 system layer1");
  // 老调用（不传 contextLayers）逐字不变
  const legacy = buildUserMessage(BASE);
  assert.ok(legacy.includes("前文:") && legacy.includes("后文:"));
});

test("不传 contextLayers 时 explainTurns 逐字不变（含 structure 与规则的控制变量）", () => {
  const plain = explainTurns(BASE);
  assert.equal(plain.length, 2);
  assert.equal(plain[1].content, buildUserMessage(BASE));
  const withOthers = explainTurns({
    ...BASE,
    askKind: "structure",
    teachingRules: "别直接给整句翻译",
    history: [{ text: "上一答" }],
  });
  // 有 structure / rules / history 时，恰好是 system×3 + history×2 + user = 6 条，没有 layer system
  assert.equal(withOthers.length, 6);
  assert.ok(!withOthers.some((t) => t.content.includes("两处上下文，别混用")));
});

test("两层上下文逐轮稳定：同一锚点、不同追问，system 部分逐字相同", () => {
  const first = explainTurns({ ...BASE, contextLayers: LAYERS, prompt: "plain 什么意思" });
  const second = explainTurns({
    ...BASE,
    contextLayers: LAYERS,
    prompt: "那 the plain one 指哪个？",
    history: [{ ask: "plain 什么意思", text: "普通的那个" }],
  });
  // 三条 system 完全一样 → KV cache 前缀命中；变化只发生在 history 与本轮 user
  const systemsOf = (ts: typeof first) => ts.filter((t) => t.role === "system");
  assert.deepEqual(systemsOf(first), systemsOf(second));
  assert.equal(systemsOf(first).length, 2, "人设 + 两层上下文");
});

test("narrowContextLayers 白名单：裁剪字数、限制条数、非法结构丢弃", () => {
  assert.deepEqual(
    narrowContextLayers({ sentence: "  A sentence.  ", nearContext: ["  prior  "], evil: "x" }),
    { sentence: "A sentence.", nearContext: ["prior"] },
    "额外字段不透传",
  );
  const long = narrowContextLayers({
    sentence: "x".repeat(CONTEXT_LAYER_SENTENCE_MAX_CHARS + 100),
    nearContext: ["y".repeat(CONTEXT_LAYER_NEAR_MAX_CHARS + 100)],
  });
  assert.equal(long?.sentence.length, CONTEXT_LAYER_SENTENCE_MAX_CHARS);
  assert.equal(long?.nearContext[0].length, CONTEXT_LAYER_NEAR_MAX_CHARS);
  assert.deepEqual(narrowContextLayers({ sentence: "   " }), undefined);
  assert.deepEqual(narrowContextLayers({ sentence: 123 }), undefined);
  assert.deepEqual(narrowContextLayers([]), undefined);
  assert.deepEqual(narrowContextLayers(null), undefined);
});

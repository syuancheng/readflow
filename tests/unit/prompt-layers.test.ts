import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOM_ASK_TAIL_HINT, explainTurns, type ExplainParams } from "../../src/lib/ai";
import { CUSTOM_TRIGGER, DOMAIN_TRIGGER, buildL0, buildL1, buildL3, windowFromLayers } from "../../src/lib/prompt/layers";
import { NEIGHBOR_MAX_CHARS, SENTENCE_MAX_CHARS, sentenceWindowOf } from "../../src/lib/prompt/sentence-window";
import { buildLearnerBlock } from "../../src/lib/learner/profile-text";
import { planHistory } from "../../src/lib/history-compress";

/**
 * P57b：v2 分层提示词。核心性质是「前缀稳定」：
 * 前面几层的字节只取决于它自己的输入，开关、选区、问法只能改变尾部。
 */
const PARAS = [
  { content: "Agents loop over tools. Each call returns a result." },
  { content: "The model decides what to do next. It may call a tool again. That is the whole idea. The loop ends when the model stops." },
  { content: "Tail paragraph here." },
];

function base(over: Partial<ExplainParams> = {}): ExplainParams {
  const win = sentenceWindowOf(PARAS, 1, 4, 9);
  return {
    word: "decides",
    context: "",
    layout: "v2",
    sentenceWindow: win,
    articleBlock: "标题：How agents work\n用户设定分类：技术文档",
    teachingRules: "学生希望老师做的：\n- 讲得简短",
    learnerStable: "学生档案（供你判断）：\n- 身份：大学生",
    learnerVolatile: "学生近况：\n- 估计水平：B1",
    personalized: true,
    cardsEnabled: true,
    askKind: "default",
    ...over,
  };
}

/** 去掉最后一条（尾部 user），只比较前缀各层 */
const prefix = (p: ExplainParams) => JSON.stringify(explainTurns(p).slice(0, -1));
const tail = (p: ExplainParams) => explainTurns(p).at(-1)!.content;

test("L0 在任何输入下都相同，且不含「本次」类变体", () => {
  assert.equal(buildL0(), buildL0());
  const turns = explainTurns(base());
  assert.equal(turns[0].role, "system");
  assert.equal(turns[0].content, buildL0());
  assert.match(turns[0].content, /制卡建议/); // 制卡规则永远在 L0
});

test("开关与变体不改前缀：制卡开关 / 领域 / 拆句 / 自由提问 / 选区 / 问题 / 观察 只改尾部", () => {
  const ref = prefix(base());
  assert.equal(prefix(base({ cardsEnabled: false })), ref);
  assert.equal(prefix(base({ askKind: "domain" })), ref);
  assert.equal(prefix(base({ askKind: "structure" })), ref);
  assert.equal(prefix(base({ askKind: "custom", prompt: "我猜这句话的意思是……" })), ref);
  assert.equal(prefix(base({ word: "loop", prompt: "为什么？" })), ref);
  assert.equal(prefix(base({ learnerVolatile: "学生近况：\n- 估计水平：B2" })), ref);
  assert.equal(prefix(base({ quote: { text: "上一轮的话", turnIndex: 0 } })), ref);
});

test("尾部确实随这些变化：制卡关闭有一行指令；domain 带领域视角；structure 带拆句方法；custom 带自由提问触发", () => {
  assert.match(tail(base({ cardsEnabled: false })), /本次不要输出「制卡建议」行/);
  assert.doesNotMatch(tail(base()), /本次不要输出「制卡建议」行/);
  assert.match(tail(base({ askKind: "domain" })), new RegExp(DOMAIN_TRIGGER));
  assert.doesNotMatch(tail(base({ askKind: "domain" })), /资深的专业技术人员/); // 领域视角全文在 L0，尾部只有触发行
  assert.match(tail(base({ askKind: "structure" })), /带学生拆开这个长句/);
  assert.doesNotMatch(tail(base()), /资深的专业技术人员|带学生拆开|本轮：从内容角度|本轮：直接回答/);
  const customTail = tail(base({ askKind: "custom", prompt: "我猜这句话的意思是先买两小瓶样品" }));
  assert.match(customTail, new RegExp(CUSTOM_TRIGGER));
  assert.ok(customTail.includes(CUSTOM_ASK_TAIL_HINT));
  assert.match(buildL0(), /【特殊问法：学生自己提问】/);
});

test("同一句里点不同的词，前缀逐字相同（上下文窗口只取决于所在句的位置）", () => {
  const a = base({ sentenceWindow: sentenceWindowOf(PARAS, 1, 4, 11), word: "decides" });
  const b = base({ sentenceWindow: sentenceWindowOf(PARAS, 1, 29, 33), word: "next" });
  assert.equal(prefix(a), prefix(b));
  assert.notEqual(tail(a), tail(b)); // 但尾部不同（选中词）
});

test("换另一句：只有上下文层（L3）变，人设 / 用户层 / 文章层不变", () => {
  const a = explainTurns(base({ sentenceWindow: sentenceWindowOf(PARAS, 1, 4, 11) }));
  const b = explainTurns(base({ sentenceWindow: sentenceWindowOf(PARAS, 1, 60, 70) }));
  assert.deepEqual(a.slice(0, 3), b.slice(0, 3));
  assert.notEqual(a[3].content, b[3].content);
});

test("换用户设置才改 L1；换文章才改 L2；换段落才改 L3", () => {
  const ref = explainTurns(base());
  const other = explainTurns(base({ teachingRules: "学生不希望老师做的：\n- 讲长句" }));
  assert.equal(other[0].content, ref[0].content);
  assert.notEqual(other[1].content, ref[1].content);
  assert.equal(other[2].content, ref[2].content);
  assert.equal(other[3].content, ref[3].content);
  const art = explainTurns(base({ articleBlock: "标题：Another" }));
  assert.equal(art[1].content, ref[1].content);
  assert.notEqual(art[2].content, ref[2].content);
  assert.equal(art[3].content, ref[3].content);
  const para = explainTurns(base({ sentenceWindow: sentenceWindowOf(PARAS, 0, 0, 6) }));
  assert.equal(para[2].content, ref[2].content);
  assert.notEqual(para[3].content, ref[3].content);
});

test("没有用户层 / 文章层 / 段落层时整层省略，不留空 system", () => {
  const turns = explainTurns(base({ teachingRules: undefined, learnerStable: undefined, personalized: false, articleBlock: undefined, sentenceWindow: undefined }));
  assert.equal(turns.length, 2); // L0 + 尾部
  assert.equal(turns.every((t) => t.content.trim().length > 0), true);
});

test("答案深度只有一份：有没有档案、个性化开不开，L0 与全部前缀都相同；不再有「替代上文」", () => {
  const on = explainTurns(base({ personalized: true }));
  const off = explainTurns(base({ personalized: false }));
  assert.deepEqual(on.slice(0, -1), off.slice(0, -1));
  const l0 = buildL0();
  assert.equal(l0.split("【答案深度").length - 1, 1, "L0 里只能有一个答案深度段");
  assert.doesNotMatch(JSON.stringify(on), /替代上文/);
  // 一份里同时写了「没有档案」和「有档案」两种判断
  assert.match(l0, /没有：只按选区本身判断/);
  assert.match(l0, /有：按下面的方式判断/);
  assert.match(l0, /最近的反馈/); // 个性化的反馈含义保留
});

test("特殊问法「从内容角度讲讲」是 L0 里的一节：触发行才启用，写明上文的释义行/句子地图/制卡建议不适用", () => {
  const l0 = buildL0();
  assert.match(l0, /【特殊问法：从内容角度讲讲这句】/);
  assert.match(l0, new RegExp(`只有当最后一条消息以「${DOMAIN_TRIGGER}」开头时才用本节`));
  assert.match(l0, /释义行、句子地图、答案深度、制卡建议」的要求一律不适用/);
  assert.match(l0, /资深的专业技术人员/);
  // 原领域提示词里对「用户消息」的描述已改成 v2 的位置（文章层 + 尾部所在句）
  assert.doesNotMatch(l0, /用户消息最前面是「这篇文章」/);
  assert.match(l0, /【这篇文章】/);
  // 领域那一轮：人设（第一条 system）与默认讲解逐字相同
  assert.equal(explainTurns(base({ askKind: "domain" }))[0].content, explainTurns(base())[0].content);
});

test("尾部顺序：变体 → 易变档案 → 所在句 → 选区 → 观察 → 引用 → 问题（问题在最后）", () => {
  const t = tail(base({
    cardsEnabled: false,
    quote: { text: "之前那句", turnIndex: 0 },
    prompt: "这里为什么用 decides？",
    signals: { source: "word", selectionWords: 1, sentence: "It decides.", sentenceWords: 2, coverage: 0.5, position: "middle" } as never,
  }));
  const at = (s: string) => t.indexOf(s);
  const order = ["本次不要输出", "学生近况", "所在句:", "用户选中:", "观察（", "你引用了自己", "学生的问题:"].map(at);
  assert.equal(order.every((i) => i >= 0), true, JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(t.trimEnd().endsWith("这里为什么用 decides？"), true);
});

test("v2 不带 monolingual；monolingual 为真时退回 v1（原有两条 messages）", () => {
  const v1 = explainTurns({ ...base(), monolingual: true });
  assert.equal(v1[0].content.startsWith("You are a native"), true);
});

test("layout 缺省或 v1：与不带 v2 字段时完全相同（回退安全）", () => {
  const plain: ExplainParams = { word: "decides", context: "x", personalized: false, cardsEnabled: true };
  assert.deepEqual(explainTurns({ ...plain, layout: "v1", sentenceWindow: SENT_WIN() }), explainTurns(plain));
});
function SENT_WIN() {
  return sentenceWindowOf(PARAS, 1, 0, 3);
}

test("L1 / L3 纯函数：空输入返回空串", () => {
  assert.equal(buildL1({}), "");
  assert.equal(buildL3(undefined), "");
  assert.equal(buildL3({ prev: "", sentence: "  ", next: "" }), "");
});

test("客户端回退：两层上下文折成窗口（前文恢复成原文顺序）", () => {
  const w = windowFromLayers({ sentence: "S.", nearContext: ["C closest.", "B.", "A earliest."] });
  assert.equal(w.prev, "A earliest. B. C closest.");
  assert.equal(w.sentence, "S.");
  assert.equal(w.next, "");
});

// ---------- 句子窗口 ----------

test("窗口三段：前文（原文顺序）+ 所在句 + 同段后一句", () => {
  const w = sentenceWindowOf(PARAS, 1, 4, 11); // "decides"，在本段第 1 句
  assert.equal(w.sentence, "The model decides what to do next.");
  assert.equal(w.next, "It may call a tool again.");
  assert.match(w.prev, /Agents loop over tools\. Each call returns a result\./); // 跨到上一段，原文顺序
  assert.equal(w.prev.indexOf("Agents loop") < w.prev.indexOf("Each call"), true);
});

test("后一句只取同段：所在句是段末就没有，不去下一段拿", () => {
  const w = sentenceWindowOf(PARAS, 1, 105, 110); // "stops." 在本段最后一句
  assert.match(w.sentence, /The loop ends when the model stops\./);
  assert.equal(w.next, "");
  assert.doesNotMatch(JSON.stringify(w), /Tail paragraph/);
  // 整段只有一句的段落：也没有后一句
  assert.equal(sentenceWindowOf(PARAS, 2, 0, 4).next, "");
});

test("首段第一句没有前文；越界下标返回空", () => {
  assert.equal(sentenceWindowOf(PARAS, 0, 0, 6).prev, "");
  assert.deepEqual(sentenceWindowOf(PARAS, 9, 0, 3), { prev: "", sentence: "", next: "" });
});

test("跨句选区：所在句合并成连续几句；后一句是最后覆盖的那句之后", () => {
  const w = sentenceWindowOf(PARAS, 1, 4, 60);
  assert.match(w.sentence, /decides what to do next\. It may call a tool again\./);
  assert.equal(w.next.startsWith("That is the whole idea"), true);
});

test("同一句里不同位置的窗口完全相同；换句才变", () => {
  const a = sentenceWindowOf(PARAS, 1, 4, 11);
  const b = sentenceWindowOf(PARAS, 1, 29, 33);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, sentenceWindowOf(PARAS, 1, 40, 44));
});

test("没有标点的超长文本：各段都有字符上限，不会塞进几千词", () => {
  const blob = "word ".repeat(3000).trim(); // 一整个没有句号的长文本
  const paras = [{ content: blob }, { content: blob }, { content: blob + ". Tail sentence here." }];
  const w = sentenceWindowOf(paras, 1, 100, 110);
  assert.equal(w.sentence.length <= SENTENCE_MAX_CHARS + 1, true);
  assert.equal(w.prev.length <= (NEIGHBOR_MAX_CHARS + 1) * 40, true);
  assert.equal(w.next.length <= NEIGHBOR_MAX_CHARS + 1, true);
  assert.equal(JSON.stringify(w).length < 6000, true);
});

test("单句超长（有标点）：所在句按字符截断，同一位置结果稳定", () => {
  const long = "A very long sentence " + "with many words ".repeat(300) + "ends here.";
  const paras = [{ content: long + " Next one is short." }];
  const a = sentenceWindowOf(paras, 0, 30, 35);
  assert.equal(a.sentence.length <= SENTENCE_MAX_CHARS + 1, true);
  assert.equal(a.next, "Next one is short.");
  assert.deepEqual(a, sentenceWindowOf(paras, 0, 60, 65));
});

// ---------- 档案拆分 ----------

const LEVEL = { cefr: "B1", vocab: 5000 } as never;
const SURVEY = { identity: "student", goals: ["tech"], stylePref: "brief" } as never;
const STATS = { lookups: 57, difficulties: ["long_sentence"], feedback: { shallow: 0, right: 1, deep: 6 } } as never;
const input = { level: LEVEL, survey: SURVEY, stats: STATS, note: "喜欢先看例子", recentFeedback: ["「太深」：…"] };

test("档案拆分：稳定段不含水平/难点/反馈/提问次数；易变段不含身份/笔记", () => {
  const stable = buildLearnerBlock({ ...input, part: "stable" });
  const vol = buildLearnerBlock({ ...input, part: "volatile" });
  assert.match(stable, /身份/);
  assert.match(stable, /老师笔记/);
  assert.doesNotMatch(stable, /估计水平|常见难点|最近的反馈|以往反馈|57/);
  assert.match(vol, /估计水平/);
  assert.match(vol, /最近的反馈/);
  assert.doesNotMatch(vol, /身份|老师笔记/);
});

test("档案拆分：稳定段不随提问次数 / 最近反馈变化", () => {
  const a = buildLearnerBlock({ ...input, part: "stable" });
  const b = buildLearnerBlock({
    ...input,
    stats: { ...(STATS as object), lookups: 58 } as never,
    recentFeedback: ["「刚好」：…"],
    part: "stable",
  });
  assert.equal(a, b);
});

test("不传 part：完整档案与原来一致（含全部行）", () => {
  const full = buildLearnerBlock(input);
  assert.match(full, /身份/);
  assert.match(full, /估计水平/);
  assert.match(full, /最近的反馈/);
});

// ---------- 历史分块压缩 ----------

const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ ask: `问题${i}`, text: `回答${i}。` + "内容。".repeat(80) }));

test("分块压缩：不传 blockSize 与原来逐字一致", () => {
  for (const n of [1, 3, 4, 5, 7, 9]) {
    const plain = planHistory(turns(n));
    const expectDigest = Math.max(0, n - 1 - 3);
    assert.equal(plain.tiers.filter((t) => t === "digest").length, expectDigest, `n=${n}`);
  }
});

test("分块压缩：要点轮数总是 3 的倍数，每 3 轮才变一次；已压缩的轮次一直不变", () => {
  const digestN = (n: number) => planHistory(turns(n), undefined, { blockSize: 3 }).tiers.filter((t) => t === "digest").length;
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8, 9, 10].map(digestN), [0, 0, 0, 0, 0, 3, 3, 3, 6]);
  // n=7（6 个非首轮）→ 3 个要点；n=8、9 → 仍是 3 个；n=10 → 6 个
  assert.deepEqual([7, 8, 9, 10].map(digestN), [3, 3, 3, 6]);
  // 同一轮一旦压成要点，内容逐字不变（前缀稳定）
  const at8 = planHistory(turns(8), undefined, { blockSize: 3 }).turns;
  const at9 = planHistory(turns(9), undefined, { blockSize: 3 }).turns;
  assert.deepEqual(at8.slice(0, 4), at9.slice(0, 4)); // 首轮 + 3 个要点
});

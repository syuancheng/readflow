import assert from "node:assert/strict";
import test from "node:test";
import { explainTurns, type ExplainParams } from "../../src/lib/ai";
import { buildL0, buildL1, buildL3, windowFromLayers } from "../../src/lib/prompt/layers";
import { paragraphWindowOf, WINDOW_WHOLE_MAX_WORDS } from "../../src/lib/prompt/paragraph-window";
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
  const win = paragraphWindowOf(PARAS, 1, 4, 9);
  return {
    word: "decides",
    context: "",
    layout: "v2",
    paragraphWindow: win,
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

test("开关与变体不改前缀：制卡开关 / 领域 / 拆句 / 选区 / 问题 / 观察 只改尾部", () => {
  const ref = prefix(base());
  assert.equal(prefix(base({ cardsEnabled: false })), ref);
  assert.equal(prefix(base({ askKind: "domain" })), ref);
  assert.equal(prefix(base({ askKind: "structure" })), ref);
  assert.equal(prefix(base({ word: "loop", prompt: "为什么？" })), ref);
  assert.equal(prefix(base({ learnerVolatile: "学生近况：\n- 估计水平：B2" })), ref);
  assert.equal(prefix(base({ quote: { text: "上一轮的话", turnIndex: 0 } })), ref);
});

test("尾部确实随这些变化：制卡关闭有一行指令；domain 带领域视角；structure 带拆句方法", () => {
  assert.match(tail(base({ cardsEnabled: false })), /本次不要输出「制卡建议」行/);
  assert.doesNotMatch(tail(base()), /本次不要输出「制卡建议」行/);
  assert.match(tail(base({ askKind: "domain" })), /资深的专业技术人员/);
  assert.match(tail(base({ askKind: "structure" })), /带学生拆开这个长句/);
  assert.doesNotMatch(tail(base()), /资深的专业技术人员|带学生拆开/);
});

test("同段内点不同的词，前缀逐字相同（段落窗口只取决于段落原文）", () => {
  const a = base({ paragraphWindow: paragraphWindowOf(PARAS, 1, 4, 9), word: "decides" });
  const b = base({ paragraphWindow: paragraphWindowOf(PARAS, 1, 60, 70), word: "tool" });
  const c = base({ paragraphWindow: paragraphWindowOf(PARAS, 1, 85, 90), word: "idea" });
  assert.equal(prefix(a), prefix(b));
  assert.equal(prefix(a), prefix(c));
  assert.notEqual(tail(a), tail(b)); // 但尾部不同（所在句、选中词）
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
  const para = explainTurns(base({ paragraphWindow: paragraphWindowOf(PARAS, 0, 0, 6) }));
  assert.equal(para[2].content, ref[2].content);
  assert.notEqual(para[3].content, ref[3].content);
});

test("没有用户层 / 文章层 / 段落层时整层省略，不留空 system", () => {
  const turns = explainTurns(base({ teachingRules: undefined, learnerStable: undefined, personalized: false, articleBlock: undefined, paragraphWindow: undefined }));
  assert.equal(turns.length, 2); // L0 + 尾部
  assert.equal(turns.every((t) => t.content.trim().length > 0), true);
});

test("个性化的深度指引在 L1（用户层），不改 L0", () => {
  const on = explainTurns(base({ personalized: true }));
  const off = explainTurns(base({ personalized: false }));
  assert.equal(on[0].content, off[0].content);
  assert.match(on[1].content, /本学生的答案深度/);
  assert.doesNotMatch(off[1].content, /本学生的答案深度/);
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
  assert.deepEqual(explainTurns({ ...plain, layout: "v1", paragraphWindow: PARAS_WIN() }), explainTurns(plain));
});
function PARAS_WIN() {
  return paragraphWindowOf(PARAS, 1, 0, 3);
}

test("L1 / L3 纯函数：空输入返回空串", () => {
  assert.equal(buildL1({ personalized: false }), "");
  assert.equal(buildL3(undefined), "");
  assert.equal(buildL3({ prevTail: "", body: "  ", sentence: "" }), "");
});

test("客户端回退：两层上下文折成窗口（前文恢复成原文顺序）", () => {
  const w = windowFromLayers({ sentence: "S.", nearContext: ["C closest.", "B.", "A earliest."] });
  assert.equal(w.prevTail, "A earliest. B. C closest.");
  assert.equal(w.body, "S.");
});

// ---------- 段落窗口 ----------

const sentence = (i: number) => `Sentence number ${i} has exactly eight words total.`;
const longPara = Array.from({ length: 60 }, (_, i) => sentence(i + 1)).join(" "); // 60×8 = 480 词

test("短段落：整段 + 前面各段末尾；所在句正确；不跨段取后文", () => {
  const w = paragraphWindowOf(PARAS, 1, 4, 9);
  assert.equal(w.body, PARAS[1].content);
  assert.equal(w.sentence, "The model decides what to do next.");
  assert.match(w.prevTail, /Agents loop over tools/);
  assert.doesNotMatch(w.body + w.prevTail, /Tail paragraph/);
});

test("首段没有前文；越界下标返回空", () => {
  assert.equal(paragraphWindowOf(PARAS, 0, 0, 3).prevTail, "");
  assert.deepEqual(paragraphWindowOf(PARAS, 9, 0, 3), { prevTail: "", body: "", sentence: "" });
});

test("跨句选区：所在句合并", () => {
  const w = paragraphWindowOf(PARAS, 1, 4, 60);
  assert.match(w.sentence, /decides what to do next\. It may call a tool again\./);
});

test("长段落：同一块里不同句的窗口完全相同；跨块才变", () => {
  const paras = [{ content: "Intro." }, { content: longPara }];
  assert.equal(longPara.split(/\s+/).length > WINDOW_WHOLE_MAX_WORDS, true);
  const pos = (n: number) => longPara.indexOf(sentence(n));
  const a = paragraphWindowOf(paras, 1, pos(20), pos(20) + 5);
  const b = paragraphWindowOf(paras, 1, pos(22), pos(22) + 5);
  assert.equal(a.body, b.body);
  assert.equal(a.prevTail, b.prevTail);
  assert.notEqual(a.sentence, b.sentence);
  const far = paragraphWindowOf(paras, 1, pos(55), pos(55) + 5);
  assert.notEqual(far.body, a.body);
  assert.equal(a.body.length < longPara.length, true); // 确实是切块，不是整段
  assert.match(a.body, new RegExp(sentence(20))); // 所在句在窗口里
});

test("长段落窗口不从段首开始时，不再取前面各段（前面的内容已在上一块里）", () => {
  const paras = [{ content: "Intro words here." }, { content: longPara }];
  const mid = longPara.indexOf(sentence(40));
  assert.equal(paragraphWindowOf(paras, 1, mid, mid + 5).prevTail, "");
  assert.match(paragraphWindowOf(paras, 1, 0, 5).prevTail, /Intro words here/);
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

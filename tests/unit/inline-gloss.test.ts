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

test("太长的释义不显示，绝不截成半句加省略号", () => {
  assert.equal(inlineGloss(null, "n. 一个非常非常非常长的中文释义片段在这里", 6), "");
  assert.ok(!inlineGloss(null, "n. 一个非常非常非常长的中文释义片段").endsWith("…"));
});

test("空值安全，Markdown 强调记号不残留", () => {
  assert.equal(inlineGloss(null, null), "");
  assert.equal(inlineGloss("", ""), "");
  assert.equal(inlineGloss(null, "**n.** 观念"), "观念");
});

// ---- P26：真实库里的样本 ----
import { aiInlineMeaning, cardGloss } from "../../src/lib/gloss";

test("P26 新格式：第一行「释义：」直接取，不带任何解释", () => {
  const ai = "释义：超智能的\n「ultraintelligent」是 Good 自己造的词：ultra-（超出）+ intelligent。";
  assert.equal(inlineGloss(ai, null), "超智能的");
  assert.equal(inlineGloss("释义：「受益于」。\nfrom 引出来源。", null), "受益于");
  assert.equal(cardGloss(ai), "超智能的");
});

test("P26 旧答案：「X」在这句里是「Y」取中文那一对，不取英文原词", () => {
  const ai =
    "「ultraintelligent」在这句里是「超智能的」——比人类智能更高一层的。词典没收录是因为它是 Good 自己造的词";
  assert.equal(inlineGloss(ai, null), "超智能的");
});

test("P26 旧答案：行首「中文」——解释、中文叫「Y」", () => {
  assert.equal(inlineGloss("「弱点挖掘」——指系统性地找出薄弱环节的过程。", null), "弱点挖掘");
  assert.equal(inlineGloss("「调用 LLM 的」——LLM-invoking actions 就是调用大模型的那些动作", null), "调用 LLM 的");
  assert.equal(
    aiInlineMeaning("MCTS 是 Monte Carlo Tree Search 的缩写，中文叫「蒙特卡洛树搜索」，一种搜索算法。"),
    "蒙特卡洛树搜索",
  );
});

test("P26 整句大意 / 整句翻译类开头不当行内标签，回退词典义", () => {
  const ai = "整句大意：不管是上下文工程还是工作流设计，都只是 harness 的一部分。\n这里的 or 译作「还是」";
  // 开头是整句大意时往下找：第二行「这里的 or 译作「还是」」才是选区在这句的意思
  assert.equal(inlineGloss(ai, "conj. 或, 或者\\n[计] 或"), "还是");
  assert.equal(inlineGloss("整句大意：这一大句在讲背景。", "conj. 或, 或者"), "或");
  assert.equal(inlineGloss("这句话的意思是：Alpha 定义 c_s，并把输入空间映射过去。", null), "");
});

test("P26 词典：ECDICT 的 a. / ad. 词性前缀也要去掉", () => {
  assert.equal(inlineGloss(null, "a. 循环的, 递归的\\n[计] 循环的; 递归的"), "循环的");
  assert.equal(inlineGloss(null, "ad. 自治地；独立自主地"), "自治地");
  assert.equal(inlineGloss(null, "(待补充释义)"), "");
});

test("P26 否定句里的词不是释义；行首「中文」优先", () => {
  assert.equal(
    inlineGloss("「弱点挖掘」——weakness 是弱点，mining 在这里不是「采矿」，而是「挖掘」。", null),
    "弱点挖掘",
  );
  assert.equal(aiInlineMeaning("mining 在这里不是「采矿」，是系统性地挖掘。"), "");
  assert.equal(
    inlineGloss("「执行智能体的代码」——executes 在这里是「运行、执行」，agents 指 AI 智能体。", null),
    "执行智能体的代码",
  );
});

test("P26 词典义项前的括号限定去掉", () => {
  assert.equal(inlineGloss(null, "a. (两者之中)任一的, (两者之中)各一的"), "任一的");
});

test("P26 多个说法只取第一个，括号限定整体去掉", () => {
  assert.equal(inlineGloss("succeeds 在这里是「（成功）做出来、解得出」，和 fails 相对。", null), "做出来");
  assert.equal(inlineGloss("hand-written 在这里是「手工写的、人手写的」", null), "手工写的");
});

test("P26 更早的格式：**在这里的意思** 小标题、这里 X 是「…」", () => {
  const ai = "**通常意思**\n表示付出得到回报、见成效。\n\n**在这里的意思**\n见效，值得，指提前投入带来好结果。";
  assert.equal(inlineGloss(ai, "通常意思"), "见效");
  assert.equal(inlineGloss("这里 benefits from 是「从……中获益／受益于」，不是「好处」", null), "从……中获益");
  assert.equal(inlineGloss(null, "通常意思"), "");
});

test("P26 词典补充说明被切断时不留半个括号", () => {
  assert.equal(inlineGloss(null, "n. 帕雷托（意大利经济学家, 社会学家）"), "帕雷托");
});

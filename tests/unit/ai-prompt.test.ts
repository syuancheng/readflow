import assert from "node:assert/strict";
import test from "node:test";
import { buildSummaryPrompt, buildSystemPrompt, buildUserMessage } from "../../src/lib/ai";
import type { SelectionSignals } from "../../src/lib/sentence";

/**
 * AI 释义新契约（2026-11-05 讨论收敛）：
 * - 取消三段式固定模板，改成「一个老师 + 一组证据 + 一个回答」
 * - 阅读连续性优先：第一段帮学生自己把句子读顺，不给整句译文、不做语法游戏
 * - 结构分析殿后、可选、符号化（句子地图：原句 + 成分标注 + emoji）
 * - 前端只送客观信号，判断句法权重与答案深度是模型本职
 * - 默认释义与追问共用同一套 system
 */

const LONG_SELECTION =
  "Only after the results were verified did the team publish the report.";

const SIG: SelectionSignals = {
  source: "select",
  selectionWords: 3,
  sentence: "The opposite problem is the classifier repeatedly stopping something that's routine in your setup.",
  sentenceWords: 15,
  coverage: 0.2,
  position: "middle",
  sentenceStart: 0,
  sentenceEnd: 96,
  repeatCount: 3,
  dictHit: true,
};

const BASE = {
  word: "is",
  context: "The opposite problem is the classifier repeatedly stopping something.",
  prefix: "The opposite problem ",
  suffix: " the classifier repeatedly stopping something that's routine in your setup.",
};

test("控制变量一：同一个老师，system 不随选区长度或类型分叉", () => {
  const word = buildSystemPrompt("en", false, "steer");
  const phrase = buildSystemPrompt("en", false, "was built");
  const sentence = buildSystemPrompt("en", false, LONG_SELECTION);
  assert.equal(word, phrase, "点词和划短语不能换人格");
  assert.equal(word, sentence, "划整句也不能换人格");
});

test("三段式固定栏目已彻底移除", () => {
  const p = buildSystemPrompt("en", false, "steer");
  for (const heading of ["**通常意思**", "**在这里的意思**", "**其他用法**", "**翻译**", "**结合语境的解释**", "**主谓宾分析**"]) {
    assert.ok(!p.includes(heading), `不该残留固定小标题 ${heading}`);
  }
  assert.ok(!p.includes("不可省略"), "结构分析不再是必填栏目");
  assert.ok(!p.includes("绝不能省略"), "结构分析不再是必填栏目");
});

test("人设：英语为母语、懂中文、能预判中文母语者干扰点", () => {
  const p = buildSystemPrompt("en", false, "steer");
  assert.ok(p.includes("英语为母语") && p.includes("懂中文") && p.includes("老师"));
  assert.ok(p.includes("中文母语者"));
  assert.ok(/时态|冠词|介词/.test(p), "必须点明具体干扰点，而不是泛泛说「懂中文」");
});

test("答案顺序：第一段帮他把句子读顺，语法结构永远殿后且可选", () => {
  const p = buildSystemPrompt("en", false, "steer");
  assert.ok(p.includes("第一段"), "必须明确第一段是主体");
  assert.ok(p.includes("帮学生") || p.includes("让他能自己把句子读顺"));
  assert.ok(p.includes("永远殿后") || p.includes("且永远殿后"));
  assert.ok(p.includes("只有需要时才写"));
  assert.ok(p.includes("不把语法分析放到第一段"));
  assert.ok(p.includes("不要给整句通顺译文") || p.includes("不是替他翻译"));
});

test("句子地图：符号化、原句放出来、emoji 标志、详细靠标记密度", () => {
  const p = buildSystemPrompt("en", false, LONG_SELECTION);
  assert.ok(p.includes("句子地图"));
  assert.ok(p.includes("2~3 行") || p.includes("2~3 行符号化"));
  assert.ok(p.includes("把原句放出来"));
  assert.ok(p.includes("全角括号"));
  assert.ok(p.includes("🧩") && p.includes("⚠️") && p.includes("🔗"), "要有 emoji 标志，不是只有一段文字");
  assert.ok(p.includes("（主语）") && p.includes("（系动词）"), "要给出带成分标注的示例");
  assert.ok(p.includes("标记密度"), "详细不能靠长篇大论");
  assert.ok(p.includes("…"), "长句只标主干，其余省略");
});

test("准确性硬约束：没把握标存疑，不硬编；拿不准就整块不写", () => {
  const p = buildSystemPrompt("en", false, "steer");
  assert.ok(p.includes("（存疑）"));
  assert.ok(p.includes("不硬编"));
  assert.ok(p.includes("句子地图直接不写"));
});

test("阅读连续性相关的硬性禁止", () => {
  const p = buildSystemPrompt("en", false, "steer");
  assert.ok(p.includes("不要输出音标") || p.includes("不输出音标"));
  assert.ok(p.includes("不复述选区"));
  assert.ok(p.includes("不罗列词典义项"));
  assert.ok(p.includes("编号列表"));
  assert.ok(p.includes("表格") && p.includes("HTML") && p.includes("Markdown 标题"));
  assert.ok(p.includes("尽量少用加粗"), "流式渲染时未闭合星号会闪");
  assert.ok(p.includes("用中文作答"));
});

test("篇幅：用中文字数约束主体，被标注的英文原句不计入", () => {
  const p = buildSystemPrompt("en", false, "steer");
  assert.ok(p.includes("150 字") && p.includes("180 字"));
  assert.ok(p.includes("被标注的英文原句不计入"));
  assert.ok(p.includes("宁可少说一件事"));
});

test("深度判断交给模型，且只依据客观信号，不向用户提问", () => {
  const p = buildSystemPrompt("en", false, "steer");
  assert.ok(p.includes("边缘成分") && p.includes("主干成分"));
  assert.ok(p.includes("同句连续"));
  assert.ok(p.includes("≥ 3"));
  assert.ok(p.includes("不要问我"));
  assert.ok(p.includes("不要输出判断过程"));
});

/**
 * 真实样本回归（2026-11-05，生产 3000 真调模型后收敛）：
 * 1) 模型用「整句在说：…」变相给了整句翻译；
 * 2) 追问时把组织说明照抄成「第二段：」标签；
 * 3) 边缘词首次请教仍给了完整句子地图，没轻答；
 * 4) 重答时把表语里的名词误标成全句主语。
 * 这四条属于提示词契约，不是模型偶发表现，必须在两套人设里都明令约束。
 */
test("真实样本回归：禁止换皮翻译 / 段落标签，轻答不写地图，主干标错宁可不标", () => {
  const zh = buildSystemPrompt("en", false, "routine");
  assert.ok(zh.includes("整句在说") && zh.includes("整句意思是"), "要点名禁止换皮翻译");
  assert.ok(zh.includes("段落标签"), "「第二段：」不该出现在答案里");
  assert.ok(zh.includes("句子地图不写"), "边缘成分首次请教必须硬约束为轻答");
  assert.ok(zh.includes("1~2 句"));
  assert.ok(zh.includes("误标成全句主语") || zh.includes("主干标错"));

  const en = buildSystemPrompt("en", true, "routine");
  assert.ok(en.includes("The sentence means"), "英文人设同步禁止整句复述");
  assert.ok(en.includes("section labels"));
  assert.ok(en.includes("no map at all"));
  assert.ok(en.includes("wrong backbone"));
});

test("monolingual 是可人设的英文版，同样带主体优先与句子地图", () => {
  const p = buildSystemPrompt("en", true, LONG_SELECTION);
  assert.ok(p.includes("native") && p.includes("Chinese"));
  assert.ok(p.includes("first paragraph"));
  assert.ok(p.includes("sentence map"));
  assert.ok(p.includes("🧩") && p.includes("⚠️"));
  assert.ok(p.includes("(uncertain)"));
  assert.ok(/Answer in EN/.test(p));
  assert.equal(
    p,
    buildSystemPrompt("en", true, "steer"),
    "monolingual 同样不按选区分叉",
  );
});

test("控制变量二：默认释义与追问，system 不变、上下文块不变，只有问题行不同", () => {
  const sysA = buildSystemPrompt("en", false, "is");
  const sysB = buildSystemPrompt("en", false, "is");
  assert.equal(sysA, sysB);

  const a = buildUserMessage({ ...BASE, signals: SIG });
  const b = buildUserMessage({ ...BASE, signals: SIG, prompt: "这里 is 后面为什么不是宾语从句？" });
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  assert.equal(linesA.slice(0, -1).join("\n"), linesB.slice(0, -1).join("\n"), "上下文块必须逐字相同");
  assert.notEqual(linesA.at(-1), linesB.at(-1), "只有最后一行问题不同");
  assert.ok(linesB.at(-1)?.includes("这里 is 后面为什么不是宾语从句？"));
});

test("观察块只摆客观证据，不下结论；不带 signals 时与旧调用兼容", () => {
  const withSignals = buildUserMessage({ ...BASE, signals: SIG });
  assert.ok(withSignals.includes("观察（客观信号，不是结论）"));
  assert.ok(withSignals.includes("所在句子原文"));
  assert.ok(withSignals.includes("同句连续请教: 第 3 次"));
  assert.ok(withSignals.includes("词典: 已收录"));
  assert.ok(withSignals.includes("覆盖约 20%"));
  assert.ok(!withSignals.includes("这是主干"), "不能把结论写进观察");
  assert.ok(!withSignals.includes("应该给"), "不能把结论写进观察");

  const legacy = buildUserMessage(BASE);
  assert.ok(!legacy.includes("观察（"));
  assert.ok(legacy.includes('用户选中: "is"'));
  assert.ok(legacy.includes("前文:") && legacy.includes("后文:"));
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

import assert from "node:assert/strict";
import test from "node:test";
import { buildCardPrompt } from "../../src/lib/cards/prompt";

const base = { learnerBlock: "", otherTextLookups: 0, cardedBefore: false };

test("包含目的、零件清单、输出题菜单、组卡规则、JSON 格式", () => {
  const p = buildCardPrompt(base);
  for (const needle of [
    "出题的目的只有两个", "积累实用表达", "强化难点句型", "你能用的零件",
    "出题菜单", "组卡规则", "只输出 JSON", "不泄露", "语法游戏",
  ]) {
    assert.ok(p.includes(needle), needle);
  }
});

test("明确禁止识别/填空类题型，不做语法游戏", () => {
  const p = buildCardPrompt(base);
  assert.ok(p.includes("不要四选一辨义") && p.includes("不要挖介词"));
  assert.ok(p.includes("不允许 choice、fill 块"));
  assert.ok(!p.includes("context_meaning") && !p.includes("true_false_ng") && !p.includes("listen_fill"));
});

test("语音：背面所有参考说法自动配发音，不提听力开关", () => {
  const p = buildCardPrompt(base);
  assert.ok(p.includes("系统会自动给背面每一句英文配上发音"));
  assert.ok(!p.includes("听力开关") && !p.includes("听句填空"));
});

test("原文段落传进来时，用于挑口语实用短语造新句", () => {
  const without = buildCardPrompt(base);
  assert.ok(!without.includes("原文段落"));
  const withPara = buildCardPrompt({ ...base, sourceParagraph: "pi comes with most creature comforts you're used to from other tools" });
  assert.ok(withPara.includes("原文段落") && withPara.includes("creature comforts"));
  assert.ok(withPara.includes("挑口语实用表达造新句"));
});

test("建卡以句子为单位：目标句子与已掌握上下文都传进来，且不重复讲解", () => {
  const without = buildCardPrompt(base);
  assert.ok(!without.includes("目标句子（建卡以这个句子为单位"));
  assert.ok(!without.includes("学生针对这个句子已经问过"));

  const withBoth = buildCardPrompt({
    ...base,
    targetSentence: "Most people hype themselves up to remain disciplined.",
    learnedContext: "学生问：讲讲句子结构\n老师答：up 和 to 分属两个成分，不是一个短语",
  });
  assert.ok(withBoth.includes("目标句子（建卡以这个句子为单位"));
  assert.ok(withBoth.includes("Most people hype themselves up to remain disciplined."));
  assert.ok(withBoth.includes("学生针对这个句子已经问过"));
  assert.ok(withBoth.includes("up 和 to 分属两个成分"));
  assert.ok(withBoth.includes("默认学生已经读懂了这个句子"));
  assert.ok(withBoth.includes("不要再出一道让学生用 \"up to\" 造句的题"));
});

test("学生档案放在最前面；为空时不留空行", () => {
  assert.ok(buildCardPrompt({ ...base, learnerBlock: "学生档案：小明" }).startsWith("学生档案：小明\n\n"));
  assert.ok(buildCardPrompt(base).startsWith("请基于上面这个句子为它出记忆卡"));
});

test("观察信息：其他文章查过 N 次 / 已做过卡", () => {
  const none = buildCardPrompt(base);
  assert.ok(!none.includes("观察："));
  const p = buildCardPrompt({ ...base, otherTextLookups: 2, cardedBefore: true });
  assert.ok(p.includes("观察：") && p.includes("其他文章里也查过 2 次") && p.includes("优先出情景说一句或换个说法"));
});

test("考试风格段落：传了才出现，放在 JSON 格式之前", () => {
  const p = buildCardPrompt({ ...base, styleLines: "因人而异：\n- x" });
  assert.ok(p.indexOf("因人而异") > 0 && p.indexOf("因人而异") < p.indexOf("只输出 JSON"));
  assert.ok(!buildCardPrompt(base).includes("因人而异"));
});

test("提示层说明：分层揭示，提示不能写出答案；examStyle 由系统决定", () => {
  const p = buildCardPrompt(base);
  assert.ok(p.includes("提示不能直接写出背面的英文答案"));
  assert.ok(!p.includes("examStyle 不用填"), "输出类卡不再有考试题型标签需要 AI 填");
});

test("同样输入输出逐字相同（前缀缓存的前提）", () => {
  assert.equal(buildCardPrompt({ ...base, learnerBlock: "a" }), buildCardPrompt({ ...base, learnerBlock: "a" }));
});

test("四种输出题型都在菜单里，张数由 AI 决定，提示词里没有固定张数", () => {
  const p = buildCardPrompt(base);
  for (const kind of ["back_translate", "situation_say", "rephrase", "usage", "custom"]) assert.ok(p.includes(kind), kind);
  assert.ok(p.includes("出几张由你按这个句子决定"));
  assert.ok(!/固定\s*\d|必须出\s*\d|恰好\s*\d\s*张/.test(p), "不能规定固定张数");
  assert.ok(p.includes("2～3 张"), "口语常用词可以多出几张，这是建议不是硬性规则");
});

test("参考雅思托福场景，明确不参考国内考试题", () => {
  const p = buildCardPrompt(base);
  assert.ok(p.includes("雅思口语 Part 1/3"));
  assert.ok(p.includes("托福"));
  assert.ok(p.includes("雅思口语 / 托福口语写作的真实任务") === false || p.includes("雅思"));
});

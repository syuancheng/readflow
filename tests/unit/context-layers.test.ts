import assert from "node:assert/strict";
import test from "node:test";
import {
  contextLayersOf,
  NEAR_CONTEXT_MAX_WORDS,
  NEAR_CONTEXT_MAX_SENTENCES,
} from "../../src/lib/sentence";

/**
 * 两层上下文（2026-11-19）：
 * - layer1「所在句」= 选区所在句，是讲的对象；
 * - layer2「近前文」= 所在句之前 ≤150 词，按句边界切、跨段往前取、倒序排列。
 *
 * 两条硬性质：① 跨段能拿到三句外的先行词（截图里 plain one → loaf cake）；
 * ② 只依赖段落原文 + 锚点，不读 savedSet 等可变状态 → 逐轮逐字稳定 → 缓存命中。
 */

/** 把字符串数组包成 contextLayersOf 要的段落结构 */
const P = (lines: string[]) => lines.map((content) => ({ content }));

/** 对话体：每句话一个自然段，Woman:/Man: 标签留在段首 */
const DIALOGUE = [
  "Woman: So I was thinking a loaf cake.",
  "Man: The bakery has banana bread.",
  "Woman: That could work.",
  "Man: Get the plain one.",
];
const dialogue = P(DIALOGUE);
/** 「plain」在这句话里的字符区间 */
const plainStart = DIALOGUE[3].indexOf("plain");
const plainEnd = plainStart + "plain one".length;

test("layer1：单词选区拿到的是所在整句，不是锚点附近的碎片", () => {
  const layers = contextLayersOf(dialogue, 3, plainStart, plainEnd);
  assert.equal(layers.sentence, "Man: Get the plain one.");
});

test("核心回归：跨三段、隔三句，近前文必须拿到 plain one 的先行词 loaf cake", () => {
  const layers = contextLayersOf(dialogue, 3, plainStart, plainEnd);
  // 四句话总共才 20 来个词，全在 150 词预算内 → 三句近前文都要取到
  assert.equal(layers.nearContext.length, 3);
  assert.ok(
    layers.nearContext.some((s) => s.includes("loaf cake")),
    `近前文应包含 loaf cake，实际：${JSON.stringify(layers.nearContext)}`,
  );
});

test("近前文按倒序：离所在句最近的排最前，且保留说话人标签", () => {
  const layers = contextLayersOf(dialogue, 3, plainStart, plainEnd);
  assert.deepEqual(layers.nearContext, [
    "Woman: That could work.",
    "Man: The bakery has banana bread.",
    "Woman: So I was thinking a loaf cake.",
  ]);
});

test("段首选区：跨段从上一段最后一句继续往前取", () => {
  const two = P(["First paragraph ends here.", "This is the selected sentence."]);
  const layers = contextLayersOf(two, 1, 5, 12);
  assert.equal(layers.sentence, "This is the selected sentence.");
  assert.deepEqual(layers.nearContext, ["First paragraph ends here."]);
});

test("150 词截断：按句边界停，不切半句", () => {
  const short = P(
    Array.from({ length: 12 }, (_, i) =>
      `Sentence number ${i} with eight English words here.`,
    ),
  );
  const layers = contextLayersOf(short, 11, 0, 10);
  // 每句 8 词左右，11 句近前文不到 150 词，全取
  assert.equal(layers.nearContext.length, 11);
  for (const s of layers.nearContext) {
    assert.ok(/^Sentence number \d+/.test(s), `近前文必须是完整句子：${s}`);
  }

  // 每段一句 18 词 × 11 句 ≈ 198 > 150，应在句子边界截断
  const long = P(
    Array.from({ length: 12 }, (_, i) =>
      `Word${i} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho.`,
    ),
  );
  const capped = contextLayersOf(long, 11, 0, 5);
  const wordCount = capped.nearContext.join(" ").split(/\s+/).filter(Boolean).length;
  assert.ok(
    wordCount >= NEAR_CONTEXT_MAX_WORDS && wordCount <= NEAR_CONTEXT_MAX_WORDS + 20,
    `应在 150 词附近按句截断，实际 ${wordCount} 词`,
  );
  assert.ok(capped.nearContext.length < 11, "不该把 11 句全取进来");
});

test("缓存稳定性：同一锚点重复计算结果逐字相同（不依赖 savedSet 之类的可变状态）", () => {
  const first = contextLayersOf(dialogue, 3, plainStart, plainEnd);
  // 旧版的 aiContextOf 会读 savedSet：用户多收几个词，窗口就变了，system 前缀跟着变，
  // 缓存当场失效。新版函数根本没有这个入参——重复调用必须逐字相同。
  const second = contextLayersOf(dialogue, 3, plainStart, plainEnd);
  assert.deepEqual(second, first);
  assert.equal(contextLayersOf.length, 4, "函数只收 段落/段号/起/止 四个参数");
});

test("段号越界或空段落：返回空上下文，不抛异常", () => {
  assert.deepEqual(contextLayersOf([], 0, 0, 1), { sentence: "", nearContext: [] });
  assert.deepEqual(contextLayersOf(dialogue, 99, 0, 1), { sentence: "", nearContext: [] });
  assert.deepEqual(contextLayersOf(P([""]), 0, 0, 0), {
    sentence: "",
    nearContext: [],
  });
});

test("句数上限：极端短句也不会撑爆条数", () => {
  const many = P(Array.from({ length: 200 }, () => "Hi."));
  const layers = contextLayersOf(many, 199, 0, 2);
  assert.equal(layers.nearContext.length, NEAR_CONTEXT_MAX_SENTENCES);
});

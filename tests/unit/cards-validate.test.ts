import assert from "node:assert/strict";
import test from "node:test";
import { validateCard } from "../../src/lib/cards/validate";
import { renderCard } from "../../src/lib/cards/render";
import type { CardSpec } from "../../src/lib/cards/spec";
import {
  baseChoiceCard, baseClozeCard, ctx, SENTENCE,
  backTranslateCard, situationCard, rephraseCard, usageCard,
} from "./cards-fixtures";

const reasonsOf = (spec: CardSpec, over = {}) => {
  const r = validateCard(spec, ctx(over));
  return r.ok ? [] : r.reasons;
};
const has = (spec: CardSpec, needle: string, over = {}) =>
  reasonsOf(spec, over).some((x) => x.includes(needle));

test("基准的输出类卡全部通过；识别类基准被新规则拒绝", () => {
  assert.deepEqual(reasonsOf(backTranslateCard()), []);
  assert.deepEqual(reasonsOf(situationCard()), []);
  assert.ok(has(baseChoiceCard(), "不允许选择题"));
  assert.ok(has(baseClozeCard(), "不允许挖空"));
});

// ---- 1 以句子为本
test("规则1：正面没有句子 → 不通过；整句音频算句子", () => {
  const noSentence = situationCard({ front: [{ t: "instruction", text: "x" }] });
  assert.ok(has(noSentence, "必须有一个句子"));
  const audio = situationCard({
    front: [{ t: "audio", of: "sentence", text: SENTENCE }, { t: "instruction", text: "用英文说出这句话" }],
    back: { answer: [{ t: "sentence", source: "paraphrase", text: "The joy was short." }] },
  });
  assert.ok(!has(audio, "必须有一个句子"));
});

// ---- 2 原句一字不改
test("规则2：原句必须逐字出自原文，正面 / 提示层 / 背面都查", () => {
  const edited = baseClozeCard({
    front: [{ t: "sentence", source: "original", text: "The ephemeral joy faded slowly.", mark: { start: 4, end: 13, as: "blank" } }],
  });
  assert.ok(has(edited, "逐字一致"));
  const inHints = baseClozeCard({ hints: [{ t: "sentence", source: "original", text: "made up" }] });
  assert.ok(has(inHints, "逐字一致"));
  const inBack = baseClozeCard({ back: { answer: [{ t: "sentence", source: "original", text: "made up" }] } });
  assert.ok(has(inBack, "逐字一致"));
  // 改写句不受限
  const para = baseClozeCard({ front: [{ t: "sentence", source: "paraphrase", text: "Anything goes here." }] });
  assert.ok(!has(para, "逐字一致"));
});

// ---- 3 不允许挖空（输出题要自己产出完整表达）
test("规则3：任何挖空/前缀标记都被拒绝，不做填空游戏", () => {
  const blank = situationCard({
    front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "blank" } }],
  });
  assert.ok(has(blank, "不允许挖空"));
  const prefix = situationCard({
    front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "prefix", keep: 3 } }],
  });
  assert.ok(has(prefix, "不允许挖空"));
  // highlight 仍允许（输出类卡的正面可高亮目标词）
  const highlight = situationCard({
    front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "highlight" } }],
  });
  assert.ok(!has(highlight, "不允许挖空"));
});

// ---- 4 不泄露
test("规则4：输出类卡正面可以有中文和目标词，但不能泄露背面的英文参考说法", () => {
  const leakFront = situationCard({
    front: [{ t: "text", text: "His excitement was ephemeral." }, { t: "instruction", text: "说一句" }],
  });
  assert.ok(has(leakFront, "不能出现背面的英文参考说法"));
  const okFront = situationCard({
    front: [{ t: "text", text: "朋友说他升职后兴奋了几天。" }, { t: "instruction", text: "用 ephemeral 说一句" }],
  });
  assert.ok(!has(okFront, "不能出现背面的英文参考说法"), "中文场景里出现目标词不算泄露");
});

// ---- 5 不允许选择题（不做语法游戏）
test("规则5：选择题块被拒绝，卡必须让用户输出英文", () => {
  const choice = baseChoiceCard();
  assert.ok(has(choice, "不允许选择题"));
  const inHint = situationCard({
    hints: [{ t: "choice", options: [{ text: "a", correct: true }, { text: "b", correct: false }] }],
  });
  assert.ok(has(inHint, "不允许选择题"));
});

// ---- 6 背面必须有英文答案
test("规则6：背面必须有答案，且是英文句子", () => {
  const noAnswer = { ...situationCard(), back: { answer: [] } } as unknown as CardSpec;
  assert.ok(has(noAnswer, "背面必须有答案"));
  const noEnglish = situationCard({ back: { answer: [{ t: "text", text: "只有中文" }] } });
  assert.ok(has(noEnglish, "背面必须有英文参考说法"));
});

// ---- 7 语音
test("规则7：背面配音不受听力开关控制；正面可自选整句音频", () => {
  const withAudio = situationCard({
    front: [...situationCard().front, { t: "audio", of: "sentence", text: SENTENCE }],
  });
  assert.deepEqual(reasonsOf(withAudio), [], "正面整句音频是出题自由，不再需要听力开关");
  const backAudio = situationCard({ back: { ...situationCard().back, audio: ["sentence"] } });
  assert.ok(!reasonsOf(backAudio).some((r) => r.includes("听力零件未开放")), "背面发音不再被任何开关拒绝");
});

// ---- 8/10/11 标签、图片、答案线
test("规则8/10/11：AI 文本里不允许出现墨墨标签、图片、答案线", () => {
  const withText = (text: string) => situationCard({ back: { ...situationCard().back, explanation: [{ t: "text", text }] } });
  for (const bad of ["[T#B#x]", "[P#L#x]", "[F#1#x]", "[E#x]", "[Card#x]", "[Choice##", "[Audio#x]"]) {
    assert.ok(has(withText(bad), "墨墨标签语法"), bad);
  }
  assert.ok(has(withText("[Pic#x]"), "不允许出现图片"));
  assert.ok(has(withText("a\n---\nb"), "答案线"));
  const inEmphasis = situationCard({ back: { ...situationCard().back, explanation: [{ t: "text", text: "ok", emphasis: ["[Pic#"] }] } });
  assert.ok(has(inEmphasis, "不允许出现图片"));
  // 普通中括号文字没问题（渲染时转义）
  assert.deepEqual(reasonsOf(withText("see [1] and [2]")), []);
});

// ---- 9 长度
test("规则9：渲染结果 1800 字通过、1801 字不通过；专业版 4000", () => {
  const spec = (pad: number) => situationCard({ back: { ...situationCard().back, explanation: [{ t: "text", text: "a".repeat(pad) }] } });
  const base = renderCard(spec(1), { sourceTitle: "" }).length;
  const pad = (limit: number) => limit - base + 1;
  assert.equal(renderCard(spec(pad(1800)), { sourceTitle: "" }).length, 1800);
  assert.deepEqual(reasonsOf(spec(pad(1800))), []);
  assert.ok(has(spec(pad(1800) + 1), "卡片太长"));
  assert.deepEqual(reasonsOf(spec(pad(4000)), { charLimit: 4000 }), []);
  assert.ok(has(spec(pad(4000) + 1), "卡片太长", { charLimit: 4000 }));
  assert.ok(has(spec(pad(1800) + 1), "1800"));
});

test("多个问题一起报", () => {
  const r = validateCard(situationCard({ front: [{ t: "instruction", text: "x" }], back: { answer: [] } } as unknown as Partial<CardSpec>), ctx());
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reasons.length >= 2);
});

// ---------- 输出类卡（原 P35 使用类） ----------
import { usesTarget, BACK_TRANSLATE_MAX_WORDS } from "../../src/lib/cards/validate";

test("P35 基准：四种使用类卡全部通过（正面可以有目标词和整句中文）", () => {
  for (const c of [backTranslateCard(), situationCard(), rephraseCard(), usageCard()]) {
    assert.deepEqual(reasonsOf(c), [], c.kind);
  }
  // 题干出现了目标词的中文意思「短暂的」，使用类卡照样通过
  assert.ok(backTranslateCard().front.some((b) => b.t === "text" && b.text.includes("短暂的")));
});

test("P35 规则1：使用类卡正面可以只有中文，但背面必须有英文句子", () => {
  const noEnglish = situationCard({ back: { answer: [{ t: "text", text: "只有中文" }] } });
  assert.ok(has(noEnglish, "背面必须有英文参考说法"));
  const emptyFront = situationCard({ front: [{ t: "instruction", text: "说一句" }] });
  assert.ok(has(emptyFront, "必须有一个句子"));
});

test("P35 规则2：正面或提示层出现背面的英文参考说法 → 不通过", () => {
  const leakFront = backTranslateCard({ front: [{ t: "text", text: `${SENTENCE}（中文）` }] });
  assert.ok(has(leakFront, "不能出现背面的英文参考说法"));
  const leakHint = situationCard({ hints: [{ t: "text", text: "his excitement was EPHEMERAL" }] });
  assert.ok(has(leakHint, "不能出现背面的英文参考说法"));
});

test("P35 规则3：回译的背面必须是原句，且不超过 35 个词", () => {
  const notOriginal = backTranslateCard({ back: { answer: [{ t: "sentence", source: "paraphrase", text: "Joy is ephemeral." }] } });
  assert.ok(has(notOriginal, "回译卡的背面必须是原句"));
  const long = Array.from({ length: BACK_TRANSLATE_MAX_WORDS + 1 }, (_, i) => (i === 3 ? "ephemeral" : "word")).join(" ") + ".";
  const tooLong = backTranslateCard({ back: { answer: [{ t: "sentence", source: "original", text: long }] } });
  assert.ok(has(tooLong, "超过 35 个词", { originalSentence: long }));
  const exact = Array.from({ length: BACK_TRANSLATE_MAX_WORDS }, () => "ephemeral").join(" ");
  const ok35 = backTranslateCard({ back: { answer: [{ t: "sentence", source: "original", text: exact }] } });
  assert.ok(!has(ok35, "超过 35 个词", { originalSentence: exact }));
});

test("P35 规则4：情景说一句 / 搭配与用法的参考说法 2～3 句", () => {
  const one = situationCard({ back: { answer: [{ t: "sentence", source: "paraphrase", text: "It was ephemeral." }] } });
  assert.ok(has(one, "2～3 句"));
  const four = situationCard({
    back: { answer: Array.from({ length: 4 }, (_, i) => ({ t: "sentence" as const, source: "paraphrase" as const, text: `Fame ${i} is ephemeral.` })) },
  });
  assert.ok(has(four, "2～3 句"));
  const usageOne = usageCard({ back: { answer: [{ t: "sentence", source: "paraphrase", text: "Ephemeral fame fades." }] } });
  assert.ok(has(usageOne, "2～3 句"));
});

test("P35 规则5：情景说一句 / 换个说法的每句参考说法都要用上目标词（认词形变化和短语）", () => {
  const missing = situationCard({
    back: {
      answer: [
        { t: "sentence", source: "paraphrase", text: "His excitement was ephemeral." },
        { t: "sentence", source: "paraphrase", text: "It did not last." },
      ],
    },
  });
  assert.ok(has(missing, "都要用上目标词"));
  assert.equal(usesTarget("We fell behind schedule.", "fall behind"), true);
  assert.equal(usesTarget("They are falling behind on rent.", "fall behind on sth"), true);
  assert.equal(usesTarget("We stayed behind.", "fall behind"), false);
  assert.equal(usesTarget("We fell over.", "fall behind"), false);
  assert.equal(usesTarget("Ephemerally so.", "ephemeral"), true);
  assert.equal(usesTarget("anything", ""), false);
  assert.equal(usesTarget("anything", "sth"), false);
});

test("P35 规则6：换个说法的正面不能已经用上目标词，也不能和答案相同", () => {
  const already = rephraseCard({ front: [{ t: "sentence", source: "paraphrase", text: "The joy was ephemeral indeed." }] });
  assert.ok(has(already, "不能已经用上目标词"));
  const noEnglish = rephraseCard({ front: [{ t: "text", text: "中文" }] });
  assert.ok(has(noEnglish, "正面要有一句英文"));
  const same = rephraseCard({
    front: [{ t: "sentence", source: "paraphrase", text: "Short joy." }],
    back: { answer: [{ t: "sentence", source: "paraphrase", text: "short JOY" }] },
  });
  assert.ok(has(same, "不能和正面的句子一样", { quote: "short" }));
});

test("P35：配音时音频标签计入字数上限", () => {
  const V = { model: "qwen3-tts-flash", voice: "Cherry" };
  const noAudio = reasonsOf(situationCard(), { charLimit: 330 });
  const withAudio = reasonsOf(situationCard(), { charLimit: 330, audio: V });
  assert.deepEqual(noAudio, []);
  assert.ok(withAudio.some((r) => r.includes("卡片太长")));
});

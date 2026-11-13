import assert from "node:assert/strict";
import test from "node:test";
import { validateCard } from "../../src/lib/cards/validate";
import { renderCard } from "../../src/lib/cards/render";
import type { CardSpec } from "../../src/lib/cards/spec";
import { baseChoiceCard, baseClozeCard, ctx, SENTENCE } from "./cards-fixtures";

const reasonsOf = (spec: CardSpec, over = {}) => {
  const r = validateCard(spec, ctx(over));
  return r.ok ? [] : r.reasons;
};
const has = (spec: CardSpec, needle: string, over = {}) =>
  reasonsOf(spec, over).some((x) => x.includes(needle));

test("基准卡全部通过", () => {
  assert.deepEqual(reasonsOf(baseChoiceCard()), []);
  assert.deepEqual(reasonsOf(baseClozeCard()), []);
});

// ---- 1 以句子为本
test("规则1：正面没有句子 → 不通过；整句音频算句子", () => {
  const noSentence = baseChoiceCard({ front: [{ t: "instruction", text: "x" }] });
  assert.ok(has(noSentence, "必须有一个句子"));
  const audio = baseChoiceCard({
    kind: "listen_fill",
    front: [{ t: "audio", of: "sentence", text: SENTENCE }, { t: "fill", answer: "ephemeral" }],
  });
  assert.ok(!has(audio, "必须有一个句子", { listeningEnabled: true }));
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

// ---- 3 标记位置
test("规则3：标记区间必须在句内；挖空盖住的必须是目标词（含词形变化）", () => {
  const out = baseClozeCard({ front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 99, as: "blank" } }] });
  assert.ok(has(out, "落在句子范围内"));
  const reversed = baseClozeCard({ front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 9, end: 4, as: "blank" } }] });
  assert.ok(has(reversed, "落在句子范围内"));
  const wrong = baseClozeCard({ front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 14, end: 18, as: "blank" } }] });
  assert.ok(has(wrong, "必须是目标词"));
  // 词形变化：quote=run，句子里是 running
  const s2 = "She was running fast.";
  const inflected = baseClozeCard({ front: [{ t: "sentence", source: "original", text: s2, mark: { start: 8, end: 15, as: "blank" } }] });
  assert.ok(!has(inflected, "必须是目标词", { originalSentence: s2, quote: "run" }));
  // 大小写不敏感
  const s3 = "Ephemeral joy.";
  const cap = baseClozeCard({ front: [{ t: "sentence", source: "original", text: s3, mark: { start: 0, end: 9, as: "blank" } }] });
  assert.ok(!has(cap, "必须是目标词", { originalSentence: s3 }));
});

// ---- 4 不泄露
test("规则4：题干不能出现中文意思；挖空卡正面不能出现完整目标词", () => {
  const gloss = baseChoiceCard({ front: [...baseChoiceCard().front, { t: "instruction", text: "意思是短暂的吗" }] });
  assert.ok(has(gloss, "中文意思"));
  const leakInstr = baseClozeCard({ front: [...baseClozeCard().front, { t: "instruction", text: "提示：Ephemeral 开头" }] });
  assert.ok(has(leakInstr, "完整的目标词"), "大小写不同也算泄露");
  const leakInflected = baseClozeCard({ front: [...baseClozeCard().front, { t: "instruction", text: "like ephemerals" }] });
  assert.ok(has(leakInflected, "完整的目标词"), "词形变化也算泄露");
  const leakHint = baseClozeCard({ front: [{ t: "sentence", source: "paraphrase", text: "x" }, { t: "fill", answer: "ephemeral", hint: "ephemeral" }] });
  assert.ok(has(leakHint, "完整的目标词"));
  // 高亮卡本来就要显示目标词，不算泄露
  assert.ok(!has(baseChoiceCard(), "完整的目标词"));
});

test("规则4：prefix 模式只露前缀，不算泄露；前缀露出整个词才算", () => {
  const prefixOk = baseClozeCard({ front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "prefix", keep: 3 } }] });
  assert.ok(!has(prefixOk, "完整的目标词"));
  const prefixAll = baseClozeCard({ front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "prefix", keep: 9 } }] });
  assert.ok(has(prefixAll, "完整的目标词"));
});

test("规则4：短语目标词大小写不同也算泄露（单词靠词形比对，短语只能靠整串比对）", () => {
  const s = "They decided to carry out the plan.";
  const phrase = (instruction: string) =>
    baseClozeCard({
      front: [
        { t: "sentence", source: "original", text: s, mark: { start: 15, end: 24, as: "blank" } },
        { t: "instruction", text: instruction },
      ],
      back: { answer: [{ t: "fill", answer: "carry out" }] },
    });
  const over = { originalSentence: s, quote: "carry out", glossZh: null };
  assert.ok(has(phrase("Use Carry Out in your own words"), "完整的目标词", over));
  assert.ok(!has(phrase("Fill in the blank"), "完整的目标词", over));
});

// ---- 5 选择题
test("规则5：选项 3~5 个、不重复、单选恰好一个正确、多选至少两个", () => {
  const choice = (options: { text: string; correct: boolean }[], multi?: boolean): CardSpec =>
    baseChoiceCard({ front: [baseChoiceCard().front[0], { t: "choice", options, ...(multi ? { multi } : {}) }] });
  const opt = (n: number, correctAt: number[]) =>
    Array.from({ length: n }, (_, i) => ({ text: `opt${i}`, correct: correctAt.includes(i) }));
  assert.ok(has(choice(opt(2, [0])), "3~5"));
  assert.ok(has(choice(opt(6, [0])), "3~5"));
  assert.ok(has(choice([{ text: "A", correct: true }, { text: "a", correct: false }, { text: "c", correct: false }]), "不能重复"));
  assert.ok(has(choice(opt(4, [0, 1])), "只能有一个"));
  assert.ok(has(choice(opt(4, [])), "只能有一个"));
  assert.ok(has(choice(opt(4, [0]), true), "至少要有 2 个"));
  assert.ok(!has(choice(opt(4, [0, 1]), true), "至少要有 2 个"));
  assert.ok(!has(choice(opt(5, [2])), "3~5"));
});

// ---- 6 只考一个点
test("规则6：背面要有答案；最多一个选择块；最多一组挖空（一段多空除外）", () => {
  const raw = baseChoiceCard();
  const noAnswer = { ...raw, back: { answer: [] } } as unknown as CardSpec;
  assert.ok(has(noAnswer, "背面必须有答案"));
  const two = baseChoiceCard({ front: [...raw.front, raw.front[2]] });
  assert.ok(has(two, "最多一个选择块"));
  const blank = (start: number, end: number) => ({ t: "sentence" as const, source: "paraphrase" as const, text: "aaa bbb", mark: { start, end, as: "blank" as const } });
  const twoBlanks = baseClozeCard({ front: [blank(0, 3), blank(4, 7)] });
  assert.ok(has(twoBlanks, "最多一组挖空"));
  const para = baseClozeCard({ kind: "paragraph_cloze", front: [blank(0, 3), blank(4, 7)] });
  assert.ok(!has(para, "最多一组挖空"));
});

// ---- 7 听力
test("规则7：听力关闭时不能有音频；听力卡的正面约束", () => {
  const withAudio = baseClozeCard({ front: [...baseClozeCard().front, { t: "audio", of: "word", text: "ephemeral" }] });
  assert.ok(has(withAudio, "听力零件未开放"));
  assert.ok(!has(withAudio, "听力零件未开放", { listeningEnabled: true }));

  const on = { listeningEnabled: true };
  const choose = baseChoiceCard({ kind: "listen_choose", front: [{ t: "audio", of: "sentence", text: SENTENCE }, { t: "sentence", source: "original", text: SENTENCE }, baseChoiceCard().front[2]] });
  assert.ok(has(choose, "不能显示句子文字", on));
  const chooseNoAudio = baseChoiceCard({ kind: "listen_choose", front: [{ t: "instruction", text: "x" }, { t: "sentence", source: "paraphrase", text: "s" }, baseChoiceCard().front[2]] });
  assert.ok(has(chooseNoAudio, "必须有音频", on));
  const fillOk = baseClozeCard({
    kind: "listen_fill",
    front: [{ t: "audio", of: "sentence", text: SENTENCE }, { t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "blank" } }],
  });
  assert.deepEqual(reasonsOf(fillOk, on), []);
  const fillNoBlank = baseClozeCard({
    kind: "listen_fill",
    front: [{ t: "audio", of: "sentence", text: SENTENCE }, { t: "sentence", source: "original", text: SENTENCE }],
  });
  assert.ok(has(fillNoBlank, "必须把目标词挖空", on));
  const fillNoAudio = baseClozeCard({ kind: "listen_fill", front: baseClozeCard().front });
  assert.ok(has(fillNoAudio, "必须有整句音频", on));
});

// ---- 8/10/11 标签、图片、答案线
test("规则8/10/11：AI 文本里不允许出现墨墨标签、图片、答案线", () => {
  const withText = (text: string) => baseClozeCard({ back: { answer: [{ t: "fill", answer: "ephemeral" }], explanation: [{ t: "text", text }] } });
  for (const bad of ["[T#B#x]", "[P#L#x]", "[F#1#x]", "[E#x]", "[Card#x]", "[Choice##", "[Audio#x]"]) {
    assert.ok(has(withText(bad), "墨墨标签语法"), bad);
  }
  assert.ok(has(withText("[Pic#x]"), "不允许出现图片"));
  assert.ok(has(withText("a\n---\nb"), "答案线"));
  // 选项文字、emphasis、customLabel 里的也查
  const inOption = baseChoiceCard({ front: [baseChoiceCard().front[0], { t: "choice", options: [{ text: "[T#x]", correct: true }, { text: "b", correct: false }, { text: "c", correct: false }] }] });
  assert.ok(has(inOption, "墨墨标签语法"));
  const inEmphasis = baseClozeCard({ back: { answer: [{ t: "text", text: "ok", emphasis: ["[Pic#"] }] } });
  assert.ok(has(inEmphasis, "不允许出现图片"));
  // 普通中括号文字没问题（渲染时转义）
  assert.deepEqual(reasonsOf(withText("see [1] and [2]")), []);
});

// ---- 9 长度
test("规则9：渲染结果 1800 字通过、1801 字不通过；专业版 4000", () => {
  const spec = (pad: number) => baseClozeCard({ back: { answer: [{ t: "fill", answer: "ephemeral" }], explanation: [{ t: "text", text: "a".repeat(pad) }] } });
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
  const r = validateCard(baseClozeCard({ front: [{ t: "instruction", text: "x" }], back: { answer: [] } } as unknown as Partial<CardSpec>), ctx());
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reasons.length >= 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import { renderPreview } from "../../src/lib/cards/render";
import { baseChoiceCard, baseClozeCard, SENTENCE } from "./cards-fixtures";

const R = { sourceTitle: "A Very Long Title ".repeat(5) };

test("预览标签：题型、风格、来源（截 40 字）", () => {
  const p = renderPreview(baseChoiceCard({ examStyle: "托福 · 词汇题" }), R);
  assert.deepEqual([p.tags.emoji, p.tags.label, p.tags.style], ["📖", "语境理解", "托福 · 词汇题"]);
  assert.equal(p.tags.source?.length, 40);
  assert.equal(renderPreview(baseChoiceCard(), { sourceTitle: "" }).tags.source, null);
});

test("预览：挖空用下划线并带答案；prefix 保留前缀字母", () => {
  const p = renderPreview(baseClozeCard(), R);
  assert.equal(p.front.lines[0].text, "The _________ joy faded quickly.");
  assert.deepEqual(p.front.lines[0].blanks, [{ answer: "ephemeral", no: 1 }]);
  const prefix = renderPreview(
    baseClozeCard({ front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "prefix", keep: 3 } }] }),
    R,
  );
  assert.equal(prefix.front.lines[0].text, "The eph______ joy faded quickly.");
  assert.deepEqual(prefix.front.lines[0].blanks, [{ answer: "emeral", no: 1 }]);
});

test("预览：选择题带正确标记；fill 带提示；音频块显示播放按钮", () => {
  const p = renderPreview(
    baseChoiceCard({
      front: [
        baseChoiceCard().front[2],
        { t: "fill", answer: "x", hint: "首字母 x" },
        { t: "audio", of: "sentence", text: "s" },
        { t: "audio", of: "word", text: "w" },
        { t: "text", text: "t", emphasis: ["a", "b", "c", "d", "e"] },
        { t: "sentence", source: "paraphrase", text: "p" },
        { t: "instruction", text: "i" },
      ],
    }),
    R,
  );
  assert.equal(p.front.lines[0].choices?.options[0].correct, true);
  assert.equal(p.front.lines[1].text, "（提示：首字母 x）____");
  assert.equal(p.front.lines[2].text, "▶ 播放整句");
  assert.equal(p.front.lines[3].text, "▶ 播放单词");
  assert.equal(p.front.lines[4].emphasis?.length, 4);
});

test("预览：提示层、背面、补充例句标记 ai", () => {
  const p = renderPreview(
    baseClozeCard({
      hints: [{ t: "text", text: "提示" }],
      back: {
        answer: [{ t: "text", text: "a" }],
        explanation: [{ t: "text", text: "e" }],
        sentenceMeaning: "m",
        structure: "s",
        example: { en: "x", zh: "y" },
        audio: ["word"],
      },
    }),
    R,
  );
  assert.equal(p.hints?.lines[0].text, "提示");
  assert.equal(p.back.explanation?.lines[0].text, "e");
  assert.deepEqual(p.back.example, { en: "x", zh: "y", ai: true });
  assert.deepEqual(p.back.audio, ["word"]);
  const bare = renderPreview(baseClozeCard(), R);
  assert.equal(bare.hints, null);
  assert.equal(bare.back.explanation, null);
  assert.equal(bare.back.example, null);
});

// ---------- P35 ----------
import { audioKey as p35Key, audioPlaceholderKeys } from "../../src/lib/cards/audio";
import { REFERENCE_NOTE_AI as P35_NOTE, SECTIONS as P35_S, renderCard } from "../../src/lib/cards/render";
import { situationCard, backTranslateCard } from "./cards-fixtures";

test("P35：预览的 audioKey 和渲染结果里的占位符一一对应；使用类卡有参考说法标题和说明行", () => {
  const V = { model: "qwen3-tts-flash", voice: "Cherry" };
  const card = situationCard();
  const p = renderPreview(card, { sourceTitle: "", audio: V });
  const keys = p.back.answer.lines.flatMap((l) => (l.audioKey ? [l.audioKey] : []));
  assert.deepEqual(keys, audioPlaceholderKeys(renderCard(card, { sourceTitle: "", audio: V })));
  assert.equal(keys[0], p35Key("His excitement was ephemeral.", V));
  assert.equal(p.back.answerTitle, P35_S.reference);
  assert.equal(p.back.referenceNote, P35_NOTE);
  assert.ok(p.back.answer.lines.every((l) => !l.ai), "参考说法不逐句标 AI 补充");
  // 正面不配音；不传音色时一个 audioKey 都没有
  assert.ok(renderPreview(backTranslateCard(), { sourceTitle: "", audio: V }).front.lines.every((l) => !l.audioKey));
  const off = renderPreview(card, { sourceTitle: "" });
  assert.ok(off.back.answer.lines.every((l) => !l.audioKey));
});

import { groupReference } from "../../src/lib/cards/render";
import { usageCard } from "./cards-fixtures";

test("P35：参考说法分组——情景说一句按「英文 + 中文」，搭配与用法按「搭配 + 例句 + 中文」", () => {
  const sit = groupReference(renderPreview(situationCard(), { sourceTitle: "" }).back.answer.lines);
  assert.deepEqual(sit.map((g) => g.map((l) => l.text)), [
    ["His excitement was ephemeral.", "他的兴奋很短暂。"],
    ["The thrill of the promotion proved ephemeral.", "升职带来的兴奋转瞬即逝。"],
  ]);
  const use = groupReference(renderPreview(usageCard(), { sourceTitle: "" }).back.answer.lines);
  assert.deepEqual(use.map((g) => g.length), [3, 3]);
  assert.equal(use[1][0].text, "ephemeral nature");
  assert.deepEqual(groupReference([]), []);
});

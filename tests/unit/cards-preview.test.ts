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

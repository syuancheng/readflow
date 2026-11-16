import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_TEXT_MAX,
  audioKey,
  audioPlaceholder,
  audioPlaceholderKeys,
  audioTextsOf,
  fillAudioIds,
  isAudioKey,
  normalizeAudioText,
  speakable,
} from "../../src/lib/cards/audio";
import { SENTENCE, backTranslateCard, situationCard, usageCard, baseChoiceCard } from "./cards-fixtures";

const V = { model: "qwen3-tts-flash", voice: "Cherry" };

test("audioKey：空白不同 key 相同；音色或模型不同 key 不同；32 位十六进制", () => {
  const a = audioKey("Hello  world. ", V);
  assert.equal(a, audioKey(" Hello world.", V));
  assert.notEqual(a, audioKey("Hello world.", { ...V, voice: "Ethan" }));
  assert.notEqual(a, audioKey("Hello world.", { ...V, model: "cosyvoice-v2" }));
  assert.ok(isAudioKey(a));
  assert.equal(isAudioKey("XYZ"), false);
  assert.equal(normalizeAudioText(" a \n b "), "a b");
});

test("speakable：空串、纯中文、超过 400 字符的不合成", () => {
  assert.equal(speakable("Hi."), true);
  assert.equal(speakable("  "), false);
  assert.equal(speakable("你好"), false);
  assert.equal(AUDIO_TEXT_MAX, 400);
  assert.equal(speakable("a".repeat(400)), true);
  assert.equal(speakable("a".repeat(401)), false);
});

test("audioTextsOf：只取背面的英文句子 + 补充例句，去重、保持顺序；正面和提示层不取", () => {
  assert.deepEqual(audioTextsOf(backTranslateCard()), [SENTENCE]);
  assert.deepEqual(audioTextsOf(situationCard()), [
    "His excitement was ephemeral.",
    "The thrill of the promotion proved ephemeral.",
  ]);
  const withExample = usageCard({
    back: {
      answer: usageCard().back.answer,
      explanation: [{ t: "sentence", source: "paraphrase", text: "Ephemeral pleasures rarely satisfy us." }],
      example: { en: "Youth is ephemeral.", zh: "青春短暂。" },
    },
  });
  assert.deepEqual(audioTextsOf(withExample), [
    "Ephemeral pleasures rarely satisfy us.",
    "Everyone noticed the ephemeral nature of fame.",
    "Youth is ephemeral.",
  ]);
  // 选择题卡：正面的原句不取，背面没有英文句子
  assert.deepEqual(audioTextsOf(baseChoiceCard()), []);
});

test("占位符：取出 key、换成 file.id、失败的整段删掉；id 里的 $ 原样保留", () => {
  const k1 = audioKey("One.", V);
  const k2 = audioKey("Two.", V);
  const content = `One. ${audioPlaceholder(k1)}\nTwo. ${audioPlaceholder(k2)}\nOne again ${audioPlaceholder(k1)}`;
  assert.deepEqual(audioPlaceholderKeys(content), [k1, k2]);
  const out = fillAudioIds(content, { [k1]: "mkjf_A$&b", [k2]: null });
  assert.equal(out, "One. [Audio#M,ID/mkjf_A$&b#]\nTwo.\nOne again [Audio#M,ID/mkjf_A$&b#]");
  assert.equal(out.includes("@AUDIO"), false);
  assert.equal(audioPlaceholder(k1), `[Audio#M,ID/@AUDIO:${k1}@#]`);
  // 行首的标签（前面没有空格）也能删掉
  assert.equal(fillAudioIds(audioPlaceholder(k2), { [k2]: null }), "");
});

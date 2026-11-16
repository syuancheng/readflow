import assert from "node:assert/strict";
import test from "node:test";
import { audioKey, audioPlaceholder } from "../../src/lib/cards/audio";
import {
  DEFAULT_VOICE_ID,
  TTS_MODEL,
  VOICE,
  VOICE_OPTIONS,
  isVoiceId,
  matchAudioKey,
  voiceInContent,
  voiceOf,
} from "../../src/lib/cards/voices";

test("P38 音色列表：默认 Jennifer，加上温柔的女声；id 不重复", () => {
  assert.equal(DEFAULT_VOICE_ID, "Jennifer");
  assert.deepEqual(VOICE, { model: TTS_MODEL, voice: "Jennifer" });
  const ids = VOICE_OPTIONS.map((o) => o.id);
  assert.deepEqual(ids, ["Jennifer", "Serena", "Maia", "Sohee", "Seren"]);
  assert.equal(new Set(ids).size, ids.length);
  for (const o of VOICE_OPTIONS) assert.ok(o.name && o.desc);
});

test("P38 isVoiceId / voiceOf：只认列表里的音色，其余回到默认", () => {
  assert.equal(isVoiceId("Serena"), true);
  assert.equal(isVoiceId("serena"), false);
  assert.equal(isVoiceId("Cherry"), false);
  assert.equal(isVoiceId(42), false);
  assert.equal(isVoiceId(null), false);
  assert.deepEqual(voiceOf("Maia"), { model: TTS_MODEL, voice: "Maia" });
  assert.deepEqual(voiceOf("unknown"), VOICE);
  assert.deepEqual(voiceOf(null), VOICE);
  assert.deepEqual(voiceOf(undefined), VOICE);
});

test("P38 matchAudioKey：按 key 找回句子和当时的音色（换音色后旧 key 仍能找回）", () => {
  const texts = ["Youth is ephemeral.", "The joy faded quickly."];
  const serena = voiceOf("Serena");
  const k = audioKey(texts[1], serena);
  assert.deepEqual(matchAudioKey(texts, k), { text: texts[1], voice: serena });
  const kDefault = audioKey(texts[0], VOICE);
  assert.deepEqual(matchAudioKey(texts, kDefault), { text: texts[0], voice: VOICE });
  assert.equal(matchAudioKey(texts, audioKey("Not in the card.", serena)), null);
  assert.equal(matchAudioKey([], k), null);
  // 不在列表里的音色合成的 key 找不回
  assert.equal(matchAudioKey(texts, audioKey(texts[0], { model: TTS_MODEL, voice: "Cherry" })), null);
});

test("P38 voiceInContent：预览按占位符里的音色算 key", () => {
  const texts = ["Youth is ephemeral."];
  const maia = voiceOf("Maia");
  const content = `正面\n---\n${texts[0]} ${audioPlaceholder(audioKey(texts[0], maia))}`;
  assert.deepEqual(voiceInContent(content, texts), maia);
  assert.equal(voiceInContent("没有占位符", texts), null);
  const stale = `x ${audioPlaceholder(audioKey("Something else.", maia))}`;
  assert.equal(voiceInContent(stale, texts), null);
});

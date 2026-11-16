import assert from "node:assert/strict";
import test from "node:test";
import { audioMimeOf, buildTtsRequest, parseTtsResponse, resolveTtsKey, ttsBase, TTS_DEFAULT_BASE } from "../../src/lib/cards/tts-api";
import { VOICE } from "../../src/lib/cards/voices";

test("请求：北京地域地址、Bearer Key、language_type English，非流式不带 SSE 头", () => {
  const r = buildTtsRequest(TTS_DEFAULT_BASE, "sk-test", "Hello there.", VOICE);
  assert.equal(r.url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
  assert.equal(r.init.method, "POST");
  assert.equal(r.init.headers.Authorization, "Bearer sk-test");
  assert.equal("X-DashScope-SSE" in r.init.headers, false);
  assert.deepEqual(JSON.parse(r.init.body), {
    model: "qwen3-tts-flash",
    input: { text: "Hello there.", voice: "Jennifer", language_type: "English" },
  });
});

test("地址：READFLOW_TTS_BASE_URL 覆盖默认，去掉末尾斜杠", () => {
  assert.equal(ttsBase({}), TTS_DEFAULT_BASE);
  assert.equal(ttsBase({ READFLOW_TTS_BASE_URL: "http://127.0.0.1:9/" }), "http://127.0.0.1:9");
});

test("响应：取 output.audio.url；没有 url 时报错并带上服务商的原因", () => {
  const ok = parseTtsResponse({ output: { audio: { url: "https://x/a.wav?Expires=1", expires_at: 99 } }, usage: { characters: 12 } });
  assert.deepEqual(ok, { url: "https://x/a.wav?Expires=1", expiresAt: 99, characters: 12 });
  assert.deepEqual(parseTtsResponse({ output: { audio: { url: "http://x/a.wav" } } }), { url: "http://x/a.wav", expiresAt: null, characters: null });
  assert.throws(() => parseTtsResponse({ code: "InvalidApiKey", message: "bad key" }), /InvalidApiKey bad key/);
  assert.throws(() => parseTtsResponse(null), /没有返回音频地址$/);
  assert.throws(() => parseTtsResponse({ output: { audio: { url: "ftp://x" } } }));
});

test("Key 的读取顺序：环境变量 → 站级设置 → 都没有", () => {
  assert.equal(resolveTtsKey({ DASHSCOPE_API_KEY: " env " }, "site"), "env");
  assert.equal(resolveTtsKey({}, " site "), "site");
  assert.equal(resolveTtsKey({ DASHSCOPE_API_KEY: "" }, "  "), null);
  assert.equal(resolveTtsKey({}, null), null);
});

test("音频格式：响应头或扩展名是 mp3 就当 mp3，其余按 wav", () => {
  assert.deepEqual(audioMimeOf("audio/mpeg", "x"), { mime: "audio/mpeg", ext: "mp3" });
  assert.deepEqual(audioMimeOf(null, "https://x/a.mp3?sig=1"), { mime: "audio/mpeg", ext: "mp3" });
  assert.deepEqual(audioMimeOf("audio/wav", "https://x/a.wav"), { mime: "audio/wav", ext: "wav" });
  assert.deepEqual(audioMimeOf(null, "https://x/a"), { mime: "audio/wav", ext: "wav" });
});

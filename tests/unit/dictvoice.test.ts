/**
 * 有道词典发音的纯逻辑（不碰网络 / DB / 文件）。
 * 实测 2026-11-23：type=1 英音，type=0/2 美音。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  DICTVOICE_DEFAULT_BASE,
  DICTVOICE_MAX_CHARS,
  accentToType,
  dictAudioKey,
  dictVoiceUrl,
  isAudioResponse,
  narrowAccent,
  normalizeDictText,
} from "../../src/lib/dictvoice-core";

test("英美音映射：us→0，gb→1", () => {
  assert.equal(accentToType("us"), 0);
  assert.equal(accentToType("gb"), 1);
  assert.equal(narrowAccent("gb"), "gb");
  assert.equal(narrowAccent("us"), "us");
  assert.equal(narrowAccent("GB"), "us", "非法/大小写不对一律按美音");
  assert.equal(narrowAccent(null), "us");
  assert.equal(narrowAccent(1), "us");
});

test("文本规整：trim + 折叠空白，空与超长返回 null 让调用方回退", () => {
  assert.equal(normalizeDictText("  most   people  set a goal "), "most people set a goal");
  assert.equal(normalizeDictText("   "), null);
  assert.equal(normalizeDictText(""), null);
  assert.equal(normalizeDictText("   \n\t "), null);
  assert.equal(normalizeDictText("a".repeat(DICTVOICE_MAX_CHARS))?.length, DICTVOICE_MAX_CHARS);
  assert.equal(normalizeDictText("a".repeat(DICTVOICE_MAX_CHARS + 1)), null);
});

test("URL 构造：英美音参数正确、文本被编码、base 末尾斜杠去掉", () => {
  const us = dictVoiceUrl(DICTVOICE_DEFAULT_BASE, "water", "us");
  const gb = dictVoiceUrl(DICTVOICE_DEFAULT_BASE, "water", "gb");
  assert.ok(us.includes("type=0") && us.includes("audio=water"));
  assert.ok(gb.includes("type=1") && gb.includes("audio=water"));
  assert.ok(dictVoiceUrl("http://x/", "a b", "us").includes("audio=a+b"));
  assert.ok(dictVoiceUrl("http://x///", "a", "us").startsWith("http://x?"));
});

test("缓存 key：同文本同口音相同，英美音不同，带 dv: 前缀", () => {
  const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
  const a = dictAudioKey("water", "us", hash);
  assert.equal(a, dictAudioKey("water", "us", hash));
  assert.notEqual(a, dictAudioKey("water", "gb", hash));
  assert.notEqual(a, dictAudioKey("coffee", "us", hash));
  assert.ok(a.startsWith("dv:"));
});

test("音频响应判定：状态 + content-type + 非空三者都要满足", () => {
  assert.equal(isAudioResponse(true, "audio/mpeg", 100), true);
  assert.equal(isAudioResponse(true, "audio/mp3; charset=binary", 1), true);
  assert.equal(isAudioResponse(false, "audio/mpeg", 100), false, "非 2xx 不算");
  assert.equal(isAudioResponse(true, "text/html", 100), false, "有道错误页不算");
  assert.equal(isAudioResponse(true, null, 100), false, "没有 content-type 不算");
  assert.equal(isAudioResponse(true, "audio/mpeg", 0), false, "空音频不算");
});

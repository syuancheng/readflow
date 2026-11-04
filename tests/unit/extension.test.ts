import { test } from "node:test";
import assert from "node:assert/strict";
import { shortGloss } from "../../src/lib/gloss";

// 插件匹配器是浏览器/Node 通用的 UMD 纯 JS，直接从源码 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RFMatch = require("../../../extension/src/matcher.js") as {
  buildEntries: (words: unknown[]) => Array<{ pattern: string; re: RegExp; gloss: string }>;
  findMatches: (
    text: string,
    entries: Array<{ pattern: string; re: RegExp; gloss: string }>,
  ) => Array<{ start: number; end: number; text: string; entry: { pattern: string; gloss: string } }>;
  escapeRegex: (s: string) => string;
};

const WORDS = [
  { id: "w1", lemma: "prompt", displayForm: "Prompt", gloss: "提示", translation: "n. 提示" },
  { id: "w2", lemma: "engineering", displayForm: "Engineering", gloss: "工程学", translation: "n. 工程学" },
  { id: "w3", lemma: "has been shown", displayForm: "has been shown", gloss: "已被证明", translation: "已被证明" },
  { id: "w4", lemma: "indicate", displayForm: "indicate", gloss: "表明", translation: "v. 表明" },
];

test("buildEntries 同时索引 displayForm 与 lemma，且去重", () => {
  const entries = RFMatch.buildEntries(WORDS);
  const patterns = entries.map((e) => e.pattern.toLowerCase());
  assert.ok(patterns.includes("prompt"));
  assert.equal(patterns.filter((p) => p === "prompt").length, 1);
  assert.ok(patterns.includes("engineering"));
  assert.ok(patterns.includes("indicate"));
});

test("长短语排在短词前面（避免 has 抢掉 has been shown）", () => {
  const entries = RFMatch.buildEntries(WORDS);
  assert.ok(entries[0].pattern.length >= entries[entries.length - 1].pattern.length);
});

test("大小写不敏感匹配，返回正确偏移", () => {
  const entries = RFMatch.buildEntries(WORDS);
  const text = "This may indicate the model rewriting.";
  const hits = RFMatch.findMatches(text, entries);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "indicate");
  assert.equal(text.slice(hits[0].start, hits[0].end), "indicate");
  assert.equal(hits[0].entry.gloss, "表明");
});

test("英文词边界：prompt 不该命中 prompting", () => {
  const entries = RFMatch.buildEntries(WORDS);
  assert.equal(RFMatch.findMatches("prompting is common", entries).length, 0);
  assert.equal(RFMatch.findMatches("a Prompt here", entries).length, 1);
});

test("短语整块命中、不被其中的短词切成多段", () => {
  const entries = RFMatch.buildEntries(WORDS);
  const text = "In AI has been shown to accelerate things.";
  const hits = RFMatch.findMatches(text, entries);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "has been shown");
  assert.equal(hits[0].entry.gloss, "已被证明");
});

test("结果按位置排序且互不重叠", () => {
  const entries = RFMatch.buildEntries(WORDS);
  const hits = RFMatch.findMatches("Prompt and indicate and Engineering", entries);
  assert.equal(hits.length, 3);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i].start >= hits[i - 1].end, "命中区间不应重叠");
  }
});

test("空词表 / 空文本安全返回", () => {
  assert.deepEqual(RFMatch.findMatches("hello", RFMatch.buildEntries([])), []);
  assert.deepEqual(RFMatch.findMatches("", RFMatch.buildEntries(WORDS)), []);
  assert.deepEqual(RFMatch.buildEntries([null, {}, { lemma: "" }]), []);
});

test("escapeRegex 处理正则元字符", () => {
  assert.equal(RFMatch.escapeRegex("a.b(c)"), "a\\.b\\(c\\)");
});

test("shortGloss：Markdown / 多行 / 超长截断", () => {
  assert.equal(shortGloss("**本句中的意思**\n表明、指出", 24), "表明、指出");
  assert.equal(shortGloss("n. 提示, 提示语\\nv. 促使", 24), "n. 提示, 提示语");
  assert.equal(
    shortGloss("n. 工程学, 工程, 操纵\\n[化] 机器", 24),
    "n. 工程学, 工程, 操纵",
  );
  assert.equal(shortGloss(""), "");
  assert.equal(shortGloss(null), "");
  const long = shortGloss("a".repeat(80));
  assert.equal(long.endsWith("…"), true);
  assert.ok(long.length <= 25);
});

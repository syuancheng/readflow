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
  pointInRects: (x: number, y: number, rects: Array<Partial<DOMRect>>, pad?: number) => boolean;
  isLookupSelection: (text: string) => boolean;
  cleanTranslation: (s: string | null | undefined) => string;
  normalizeBlockText: (s: string) => string;
  normalizedIndex: (raw: string, at: number) => number;
  sentenceAround: (text: string, start: number, end: number) => string;
  normalizePhonetic: (s: string | null | undefined) => string;
  renderMarkdown: (text: string) => string;
  escHtml: (s: string | null | undefined) => string;
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

test("插件点击查词：只有点在单词的框里才算（空白处不弹卡片）", () => {
  // 一个词在屏幕上占 100..160 × 200..220
  const word = [{ left: 100, right: 160, top: 200, bottom: 220, width: 60, height: 20 }];
  assert.equal(RFMatch.pointInRects(130, 210, word), true, "点在词上");
  assert.equal(RFMatch.pointInRects(161, 210, word), true, "边缘 2px 容差内");
  assert.equal(RFMatch.pointInRects(300, 210, word), false, "同一行右边的空白");
  assert.equal(RFMatch.pointInRects(130, 260, word), false, "段落之间的空白");
  // 词跨两行时有两个框，点中任意一个都算
  const wrapped = [...word, { left: 0, right: 40, top: 230, bottom: 250, width: 40, height: 20 }];
  assert.equal(RFMatch.pointInRects(20, 240, wrapped), true);
  // 不可见的零尺寸框不算命中
  assert.equal(RFMatch.pointInRects(0, 0, [{ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }]), false);
});

test("插件拖选查词：必须含字母、不超过 120 字", () => {
  assert.equal(RFMatch.isLookupSelection("disparate"), true);
  assert.equal(RFMatch.isLookupSelection("  steerability challenge "), true);
  assert.equal(RFMatch.isLookupSelection("   "), false, "拖过空白");
  assert.equal(RFMatch.isLookupSelection("—— , ."), false, "只有标点");
  assert.equal(RFMatch.isLookupSelection("a".repeat(121)), false, "太长不是查词");
});

test("插件卡片释义：ECDICT 的字面 \\n 还原成换行", () => {
  assert.equal(RFMatch.cleanTranslation("a. 根本不同的\\nn. 无法相比的东西"), "a. 根本不同的\nn. 无法相比的东西");
  assert.equal(RFMatch.cleanTranslation(null), "");
});

/* ---------------- P31 移植到插件的纯函数 ---------------- */

test("normalizeBlockText：换行 / nbsp / 连续空格都压成一个空格", () => {
  assert.equal(RFMatch.normalizeBlockText("a\u00a0b   c\n\td"), "a b c d");
  assert.equal(RFMatch.normalizeBlockText("  首尾空白  "), "首尾空白");
});

test("normalizedIndex：块原文下标 → 归一化后下标", () => {
  const raw = "The  quick\nbrown";
  const norm = RFMatch.normalizeBlockText(raw);
  assert.equal(norm, "The quick brown");
  // "quick" 在原文从 5 开始，归一化后也是 4
  assert.equal(RFMatch.normalizedIndex(raw, raw.indexOf("quick")), norm.indexOf("quick"));
  // "brown" 在原文跨了换行，换算后仍能对上
  assert.equal(RFMatch.normalizedIndex(raw, raw.indexOf("brown")), norm.indexOf("brown"));
});

test("sentenceAround：返回选区所在的整句", () => {
  const text = "First one. The optimization target matters. Last one.";
  const start = text.indexOf("target");
  assert.equal(RFMatch.sentenceAround(text, start, start + 6), "The optimization target matters.");
});

test("normalizePhonetic：老式重音记号换成 IPA", () => {
  assert.equal(RFMatch.normalizePhonetic("'glisn"), "ˈglisn");
  assert.equal(RFMatch.normalizePhonetic("kɒ:"), "kɒː");
  // 空格分隔的多个变体只取第一个（与 src/lib/text.ts 同规则）
  assert.equal(RFMatch.normalizePhonetic("'pri:.print prɪnt"), "ˈpriːˌprint");
  assert.equal(RFMatch.normalizePhonetic(null), "");
});

test("renderMarkdown：先转义再渲染，模型输出的 HTML 只能当文字", () => {
  const html = RFMatch.renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(html.includes("&lt;img"), html);
  assert.ok(!html.includes("<img"), html);
  assert.ok(!html.includes("onerror=\"alert"), "引号也要转义");
});

test("renderMarkdown：粗体、列表、释义行、换行", () => {
  const html = RFMatch.renderMarkdown("释义：超智能的\n- 第一条\n- 第二条\n\n**重点**");
  assert.ok(html.includes('<p class="rf-gloss-line">'), html);
  assert.ok(html.includes("<b>释义：超智能的</b>"), html);
  assert.ok(html.includes("<ul>") && html.includes("<li>第一条</li>"), html);
  assert.ok(html.includes("<b>重点</b>"), html);
});

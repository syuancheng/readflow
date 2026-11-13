import { test } from "node:test";
import assert from "node:assert/strict";
import { blockSimilarity,
  locateInParagraphs,
  normalizeBlockText,
  stripHash,
  textFragmentUrl,
} from "../../src/lib/web-anchor";

/* ---------------- normalizeBlockText ---------------- */

test("normalizeBlockText：nbsp、换行、连续空格都压成一个空格", () => {
  assert.equal(normalizeBlockText("a\u00a0b   c\n\td"), "a b c d");
  assert.equal(normalizeBlockText("  前后有空白  "), "前后有空白");
  assert.equal(normalizeBlockText(""), "");
});

test("normalizeBlockText：保留原有单空格，不改变词序", () => {
  const src = "The quick brown fox";
  assert.equal(normalizeBlockText(src), src);
});

/* ---------------- stripHash ---------------- */

test("stripHash：去掉 fragment，保留 query", () => {
  assert.equal(stripHash("https://e.com/a?b=1#c"), "https://e.com/a?b=1");
  assert.equal(stripHash("https://e.com/a#only"), "https://e.com/a");
  assert.equal(stripHash("https://e.com/a"), "https://e.com/a");
});

/* ---------------- locateInParagraphs ---------------- */

const paras = [
  { id: "p1", content: "The quick brown fox jumps over the lazy dog." },
  { id: "p2", content: "Optimization target matters a lot in this system." },
];

test("locateInParagraphs：块与段落完全相等 → 直接用请求里的坐标", () => {
  const block = paras[1].content;
  const start = block.indexOf("target");
  const hit = locateInParagraphs(paras, block, start, start + "target".length);
  assert.deepEqual(hit, { paragraphId: "p2", start, end: start + 6 });
  assert.equal(paras[1].content.slice(hit!.start, hit!.end), "target");
});

test("locateInParagraphs：段落包含块（网页把一段拆成了几个元素）", () => {
  const block = "brown fox jumps";
  const hit = locateInParagraphs(paras, block, 0, block.length);
  assert.equal(hit?.paragraphId, "p1");
  assert.equal(paras[0].content.slice(hit!.start, hit!.end), "brown fox jumps");
});

test("locateInParagraphs：块包含段落（网页把几段塞进一个元素）", () => {
  const block = `${paras[0].content}\n${paras[1].content}`;
  const start = block.indexOf("lazy");
  const hit = locateInParagraphs(paras, block, start, start + 4);
  assert.equal(hit?.paragraphId, "p1");
  assert.equal(paras[0].content.slice(hit!.start, hit!.end), "lazy");
});

test("locateInParagraphs：同一段里出现多次 → 靠前文区分", () => {
  const content = "We ship fast. Ship fast is the motto. Ship fast, always.";
  const list = [{ id: "px", content }];
  // 第三个 "fast" 的前文是 "Ship fast, always" 之前那段
  const block = "We ship fast. Ship fast is the motto. Ship fast, always.";
  const start = block.lastIndexOf("fast");
  const hit = locateInParagraphs(list, block, start, start + 4);
  assert.equal(hit?.start, content.lastIndexOf("fast"));
  assert.equal(content.slice(hit!.start, hit!.end), "fast");
});

test("locateInParagraphs：空白不一致（换行 vs 空格）也能定位且切片正确", () => {
  const content = "People keep\ntalking about the\noptimization target today.";
  const list = [{ id: "pn", content }];
  // 插件端已经把块文本归一化成单空格
  const block = normalizeBlockText(content);
  const start = block.indexOf("the optimization target");
  const end = start + "the optimization target".length;
  const hit = locateInParagraphs(list, block, start, end);
  assert.ok(hit, "应该命中");
  assert.equal(hit!.paragraphId, "pn");
  // 坐标落在段落原文上：空白可能与归一化后的块不同，但文字必须一致
  assert.equal(normalizeBlockText(content.slice(hit!.start, hit!.end)), block.slice(start, end));
});

test("locateInParagraphs：找不到 → null", () => {
  assert.equal(locateInParagraphs(paras, "nothing like this here", 0, 5), null);
  assert.equal(locateInParagraphs([], "anything", 0, 4), null);
  assert.equal(locateInParagraphs(paras, paras[0].content, 3, 3), null, "空选区不猜");
});

test("locateInParagraphs：每个命中都满足 content.slice === quote", () => {
  const list = [
    { id: "a", content: "Alpha beta gamma." },
    { id: "b", content: "Beta gamma delta." },
  ];
  for (const p of list) {
    const quote = "gamma";
    const at = p.content.indexOf(quote);
    const hit = locateInParagraphs(list, p.content, at, at + quote.length);
    assert.ok(hit);
    assert.equal(p.content.slice(hit!.start, hit!.end), quote);
  }
});

/* ---------------- textFragmentUrl ---------------- */

test("textFragmentUrl：含文本片段语法，前后文按词截断", () => {
  const url = textFragmentUrl(
    "https://example.com/post#section",
    "optimization target",
    "we should focus on the",
    "because it drives growth",
  );
  assert.ok(url.startsWith("https://example.com/post#:~:text="), url);
  assert.ok(!url.includes("#section"), "#fragment 必须去掉");
  // prefix 只取末尾 3 个词（focus on the），suffix 只取开头 3 个词
  assert.ok(url.includes(encodeURIComponent("focus on the")), url);
  assert.ok(!url.includes(encodeURIComponent("should")), "prefix 超出 3 个词的部分应丢掉");
  assert.ok(url.includes(encodeURIComponent("because it drives")), url);
});

test("textFragmentUrl：- 和 , 必须转义成 %2D / %2C", () => {
  const url = textFragmentUrl("https://e.com/a", "well-known, really", "", "");
  assert.ok(url.includes("%2D"), url);
  assert.ok(url.includes("%2C"), url);
  assert.ok(!/[^-%](?:-|,)/.test(url.slice(url.indexOf("#:~:text="))), "片段里不能再有裸 - 或 ,");
});

test("textFragmentUrl：前后文为空时省略对应分隔符", () => {
  const onlyText = textFragmentUrl("https://e.com/a", "hello", "", "");
  assert.equal(onlyText, "https://e.com/a#:~:text=hello");

  const withPrefix = textFragmentUrl("https://e.com/a", "hello", "say", "");
  assert.equal(withPrefix, "https://e.com/a#:~:text=say-,hello");

  const withSuffix = textFragmentUrl("https://e.com/a", "hello", "", "again");
  assert.equal(withSuffix, "https://e.com/a#:~:text=hello,-again");
});

/* ---------- P31 验收修复：标题不能被当成正文段落 ---------- */

const withHeading = [
  { id: "heading", content: "Skills" },
  { id: "body", content: "Skills are prompts and contextual resources that activate on demand." },
];

test("locateInParagraphs：网页多了脚注标记，仍定位到正文段，不会落到同名标题上", () => {
  const block = "Skills are prompts and contextual resources that activate on demand [1].";
  const first = locateInParagraphs(withHeading, block, 0, 6);
  assert.equal(first?.paragraphId, "body");
  const at = block.indexOf("demand");
  const last = locateInParagraphs(withHeading, block, at, at + 6);
  assert.equal(last?.paragraphId, "body");
  assert.equal(withHeading[1].content.slice(last!.start, last!.end), "demand");
});

test("locateInParagraphs：正文和网页差太多时宁可返回 null，也不把标题当成同一段", () => {
  const block = "Skills turn a general model into a specialist with the right context, loaded on demand.";
  assert.equal(locateInParagraphs(withHeading, block, 0, 6), null);
});

test("locateInParagraphs：网页把标题和正文合进一个元素，点正文里的词落到正文段", () => {
  const block = `${withHeading[0].content} ${withHeading[1].content}`;
  const at = block.indexOf("prompts");
  const hit = locateInParagraphs(withHeading, block, at, at + 7);
  assert.equal(hit?.paragraphId, "body");
});

test("blockSimilarity：短段落被长块包含时得分很低，几乎相同的两段得分高", () => {
  assert.ok(blockSimilarity("Skills", withHeading[1].content) < 0.2);
  assert.ok(
    blockSimilarity(withHeading[1].content, "Skills are prompts and contextual resources that activate on demand [1].") >= 0.8,
  );
});

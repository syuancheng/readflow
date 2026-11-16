import assert from "node:assert/strict";
import test from "node:test";
import { selectionKind, selectionSignals, splitSentences } from "../../src/lib/sentence";

/**
 * 选区三分类（几何信号，纯函数）：
 * - 单个词 → word
 * - 多词短语 → phrase
 * - 句子（句末标点收尾 / ≥15 词长选区）→ sentence
 *
 * 注意：新版 AI 释义不再用它决定输出模板，只作为客观证据之一。
 */
test("单词：无空白即 word", () => {
  assert.equal(selectionKind("prompt"), "word");
  assert.equal(selectionKind("  Prompt  "), "word"); // 首尾空白不算词间空格
  assert.equal(selectionKind("don't"), "word");
  assert.equal(selectionKind(""), "word"); // 空选区兜底按单词处理
});

test("短语：多词、无句末标点、不足长句", () => {
  assert.equal(selectionKind("prompt engineering"), "phrase");
  assert.equal(selectionKind("In-Context Prompting"), "phrase");
  assert.equal(selectionKind("refers to methods for how to communicate"), "phrase");
});

test("句子：以句末标点收尾（引号/括号可跟在后面）", () => {
  assert.equal(
    selectionKind("This post only focuses on prompt engineering."),
    "sentence",
  );
  assert.equal(selectionKind("What does steerable mean?"), "sentence");
  assert.equal(selectionKind('He called it "prompt engineering."'), "sentence");
  assert.equal(selectionKind("(see the previous post!)"), "sentence");
  assert.equal(selectionKind("tricks can be explained…"), "sentence");
});

test("长选区兜底：≥15 词无标点也按句子处理", () => {
  const longClause = Array.from({ length: 15 }, (_, i) => `word${i}`).join(" ");
  assert.equal(selectionKind(longClause), "sentence");
  // 14 词仍是短语
  assert.equal(selectionKind(longClause.split(" ").slice(0, 14).join(" ")), "phrase");
});

test("短语里带缩写点不算句子（e.g. / etc. 不在句尾即可）", () => {
  assert.equal(selectionKind("methods for e.g. cloze tests"), "phrase");
});

const PARA =
  "The opposite problem is the classifier repeatedly stopping something that's routine in your setup.";

/** 阅读器采集的客观信号，随释义请求送给模型（不是结论） */
test("selectionSignals：单词选区给出所在句原文、词数与覆盖率", () => {
  const s = PARA.indexOf("classifier");
  const sig = selectionSignals(PARA, s, s + "classifier".length, "word");
  assert.equal(sig.source, "word");
  assert.equal(sig.selectionWords, 1);
  assert.equal(sig.sentence.trim(), PARA.trim(), "所在句必须是完整句子，供句子地图标注");
  assert.equal(sig.sentenceWords, sig.sentence.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length);
  assert.ok(sig.coverage > 0 && sig.coverage < 1);
  assert.ok(["start", "middle", "end"].includes(sig.position));
});

test("selectionSignals：拖选短语与点词只是 source 不同，其余证据同构", () => {
  const s = PARA.indexOf("repeatedly stopping");
  const phrase = selectionSignals(PARA, s, s + "repeatedly stopping".length, "select");
  const word = selectionSignals(PARA, s, s + "repeatedly".length, "word");
  assert.equal(phrase.source, "select");
  assert.equal(word.source, "word");
  assert.equal(phrase.selectionWords, 2);
  assert.equal(word.selectionWords, 1);
  assert.equal(phrase.sentence, word.sentence, "同句内不同选区，句子原文应完全一致");
  assert.ok(phrase.coverage > word.coverage);
});

test("selectionSignals：跨句选区合并句子区间，不丢上下文", () => {
  const two = "First sentence ends here. Second sentence starts now.";
  const sig = selectionSignals(two, 18, 40, "select");
  assert.ok(sig.sentence.includes("First") && sig.sentence.includes("Second"));
  assert.ok(sig.sentenceWords >= 7);
  assert.ok(sig.sentenceStart <= 18 && sig.sentenceEnd >= 40);
});

test("selectionSignals：位置是粗证据，句首/句末可区分", () => {
  assert.equal(selectionSignals(PARA, 0, 3, "word").position, "start");
  assert.equal(selectionSignals(PARA, PARA.length - 8, PARA.length, "select").position, "end");
});

test("selectionSignals：确定性纯函数，越界与空段落不崩", () => {
  const a = selectionSignals(PARA, 10, 30, "select");
  const b = selectionSignals(PARA, 10, 30, "select");
  assert.deepEqual(a, b, "同样的输入必须给出完全同样的输出（不依赖 ICU 随机性）");
  const empty = selectionSignals("", 0, 5, "word");
  assert.equal(empty.selectionWords, 0);
  assert.equal(empty.sentence, "");
  assert.ok(empty.coverage >= 0 && empty.coverage <= 1);
});

/**
 * 句子切分（返回字符区间）—— 锚点 prefix/suffix、「所在句」、AI 上下文都靠它。
 *
 * 回归背景：Intl.Segmenter 有两个方向的错，两个方向都必须锁死：
 *   ① 句号 + 空格 + 小写词 → 一律当缩写不切（"harness. pi comes" 整段成一句）：
 *      本 bug 的源头，comforts 的 prefix 混进上一句、整句提问解释了两句。
 *   ② 真缩写 + 句号 + 空格 + 大写词 → 反而切开（"Mr. Brown" 被切成两句）：
 *      会把人名/机构名拦腰截断。
 * 所以实现必须同时「补切」和「防过度切」，不能只往一个方向修。
 */

/** 线上出问题的原句：两句之间是 ". "，第二句以冒号收尾、以小写 pi 开头 */
const BUG_PARA =
  "I don't need to explain what features you should expect from a coding agent harness. " +
  "pi comes with most creature comforts you're used to from other tools:";

test("splitSentences：回归原句必须切成两句，句号后小写 pi 不是缩写", () => {
  const spans = splitSentences(BUG_PARA);
  assert.equal(spans.length, 2, "原句必须切成两句");
  assert.match(BUG_PARA.slice(spans[0].start, spans[0].end), /harness\.?\s*$/);
  assert.match(BUG_PARA.slice(spans[1].start, spans[1].end), /^\s*pi comes/);
});

/** 几十个常见小写词，逐个控制变量：只换句号后的第一个词，其余完全相同 */
const LOWER_START_WORDS =
  "pi go it an is do to we my no so up us he she they the a next then this that " +
  "abc foo bar baz one two three yes ok why how and but for from with are was were be been being";
test("splitSentences：句号后跟任意小写词都要切句（逐个词覆盖，防止只修 pi）", () => {
  for (const w of LOWER_START_WORDS.split(" ")) {
    const text = `First sentence ends here. ${w} continues on.`;
    const spans = splitSentences(text);
    assert.equal(spans.length, 2, `小写词 "${w}" 在句号后必须起新句`);
    const second = text.slice(spans[1].start, spans[1].end);
    assert.ok(second.trimStart().startsWith(w), `"${w}" 必须是第二句开头，实际: ${second}`);
  }
});

/** 真缩写：句号前的词是缩写，不构成句子边界（含缩写后跟大写人名） */
const ABBREV_CASES: Array<[string, number]> = [
  ["He saw Mr. Brown. Then he left.", 2],
  ["Dr. Smith went home. He slept.", 2],
  ["Mrs. Jones arrived. She smiled.", 2],
  ["Prof. Chen spoke. We listened.", 2],
  ["Use e.g. this one. Or that.", 2],
  ["That is i.e. the same thing. Next.", 2],
  ["We tried many things etc. Then stopped.", 2],
  ["This is A vs. B. Choose one.", 2],
  ["Kaplan et al. (2020) found a trend. We replicate it.", 2],
  ["The U.S. President spoke. Then left.", 2],
  ["She got a Ph.D. Then she left.", 2],
  ["Meet me at 5 p.m. Tomorrow we leave.", 2],
  ["No. 5 is the best. Take it.", 2],
  ["Apple Inc. announced it. Shares rose.", 2],
  ["It is on Main St. Then we went home.", 2],
  ["J.R.R. Tolkien wrote it. Fans loved it.", 2],
  ["Jan. 5 was cold. Feb. 6 was warmer.", 2],
];
test("splitSentences：真缩写（含后接大写词）不切断句子", () => {
  for (const [text, expected] of ABBREV_CASES) {
    const spans = splitSentences(text);
    assert.equal(spans.length, expected, `缩写句被误切: ${text}\n实际: ${JSON.stringify(spans.map((s) => text.slice(s.start, s.end)))}`);
  }
});

/** 数字小数点、URL、版本号的点不是句子边界；引号/括号可收尾；换行与省略号是边界 */
const PUNCT_CASES: Array<[string, number]> = [
  ["It costs $3.50. Too expensive.", 2],
  ["Version 1.2.3 is out. Upgrade now.", 2],
  ["Visit example.com today. It is useful.", 2],
  ['He said "Hi." Then he left.', 2],
  ["(see the previous post!) Next one.", 2],
  ["Wait... what happened?", 2],
  ["Really?! Yes.", 2],
  ["Line one.\nLine two.", 2],
  ["Line one.\n\nLine two.", 2],
  ["One. Two. Three.", 3],
  ["No punctuation here", 1],
  ["   ", 1],
];
test("splitSentences：小数点/URL/引号括号/省略号/换行的边界都正确", () => {
  for (const [text, expected] of PUNCT_CASES) {
    const spans = splitSentences(text);
    assert.equal(spans.length, expected, `标点句被误切: ${text}\n实际: ${JSON.stringify(spans.map((s) => text.slice(s.start, s.end)))}`);
  }
});

test("splitSentences：区间连续、不重叠、覆盖全文；空文本不崩", () => {
  const samples = [
    BUG_PARA,
    ...ABBREV_CASES.map(([t]) => t),
    ...PUNCT_CASES.map(([t]) => t),
    ...LOWER_START_WORDS.split(" ").map((w) => `First ends here. ${w} continues.`),
    "",
  ];
  for (const text of samples) {
    const spans = splitSentences(text);
    assert.ok(spans.length >= 1, `至少要有一段: ${JSON.stringify(text)}`);
    let cursor = 0;
    for (const sp of spans) {
      assert.ok(sp.end >= sp.start, `区间 end 必须 >= start: ${JSON.stringify(spans)}`);
      assert.ok(sp.start >= cursor, `区间不能重叠: ${JSON.stringify(spans)}`);
      cursor = sp.end;
    }
    assert.ok(cursor >= text.length, `区间必须覆盖全文: ${JSON.stringify(spans)}`);
  }
  assert.deepEqual(splitSentences(""), [{ start: 0, end: 0 }]);
});

test("selectionSignals：回归原句的所在句只含当前句，不含上一句", () => {
  const at = BUG_PARA.indexOf("comforts");
  const sig = selectionSignals(BUG_PARA, at, at + "comforts".length, "word");
  assert.ok(!sig.sentence.includes("I don't need"), `所在句不该混进上一句: ${sig.sentence}`);
  assert.ok(sig.sentence.startsWith("pi comes"), `所在句应从 pi 开头: ${sig.sentence}`);
});

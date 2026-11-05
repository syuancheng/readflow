import assert from "node:assert/strict";
import test from "node:test";
import {
  CEFR_LEVELS,
  LEVEL_BAND_WIDTH,
  MAX_COCA_RANK,
  MIN_WORDS,
  adjacentOfScore,
  analyzeFeatures,
  asCefrLevel,
  estimateCefr,
  levelOfScore,
  parseCefrDetail,
  splitSentences,
  wordsOf,
  type RankLookup,
} from "../../src/lib/cefr";

/**
 * 这一组单测刻意做成「控制变量实验」：每次只改一个输入，看输出里该变的变、
 * 不该变的不变。CEFR 估级是两条独立特征路的加权和，只断言最终级别的话，
 * 任何一路算错都可能被另一路掩盖过去。
 */

const POOL = [
  "the", "and", "of", "to", "in", "is", "it", "you",
  "he", "was", "for", "on", "are", "with", "as", "his",
  "they", "be", "at", "by",
];
const WORDS = Array.from({ length: 600 }, (_, i) => POOL[i % POOL.length]);

/** 把同一批词按不同句长断句：词的多重集合完全相同，只有句子边界不同 */
function textFromWords(words: string[], sentenceLength: number): string[] {
  const sents: string[] = [];
  for (let i = 0; i < words.length; i += sentenceLength) {
    sents.push(words.slice(i, i + sentenceLength).join(" ") + ".");
  }
  return [sents.join(" ")];
}

const allEasy: RankLookup = () => 10;
const allHard: RankLookup = () => 20000;
const mixed: RankLookup = (w) => {
  const i = POOL.indexOf(w);
  if (i < 0) return null;
  if (i < 8) return 500;
  if (i < 15) return 4000;
  return 30000;
};

test("levelOfScore：6 级等宽分带，边界不重叠、100 分封顶", () => {
  assert.equal(LEVEL_BAND_WIDTH, 100 / 6);
  assert.equal(levelOfScore(0), "A1");
  assert.equal(levelOfScore(16.6), "A1");
  assert.equal(levelOfScore(16.7), "A2");
  assert.equal(levelOfScore(33.3), "A2");
  assert.equal(levelOfScore(33.4), "B1");
  assert.equal(levelOfScore(50.1), "B2");
  assert.equal(levelOfScore(66.7), "C1");
  assert.equal(levelOfScore(83.4), "C2");
  assert.equal(levelOfScore(100), "C2");
  assert.equal(levelOfScore(-5), "A1");
  CEFR_LEVELS.forEach((level, i) => {
    assert.equal(levelOfScore(i * LEVEL_BAND_WIDTH + 1), level);
  });
});

test("adjacentOfScore：贴近边界才承认相邻级别，带中间为 null", () => {
  assert.equal(adjacentOfScore(16.7), "A1", "刚进 A2，仍可能是 A1");
  assert.equal(adjacentOfScore(64), "C1", "B2 带上沿，接近 C1");
  assert.equal(adjacentOfScore(41.7), null, "B1 中间不该给相邻级");
  assert.equal(adjacentOfScore(0), null, "A1 没有更低级");
  assert.equal(adjacentOfScore(100), null, "C2 没有更高级");
});

test("wordsOf：丢掉单字母变量 / 数字 / 标点，连字符词算一个", () => {
  assert.deepEqual(wordsOf("n d beta, few-shot API 3.14"), ["beta", "few-shot", "api"]);
  assert.deepEqual(wordsOf("这是一段中文"), []);
});

test("splitSentences：缩写与首字母不当句子边界", () => {
  assert.equal(splitSentences("Dr. Smith went home. He slept.").length, 2);
  assert.equal(splitSentences("He saw Mr. Brown. Then he left.").length, 2);
  assert.equal(splitSentences("Use e.g. this one. Or that.").length, 2);
  assert.equal(splitSentences("One. Two. Three.").length, 3);
  // 参考文献里的 "et al." 不是句子边界：技术文章里一次出现几十回，
  // 误断会把平均句长压低、把 CEFR 复杂度路整个带偏
  assert.equal(splitSentences("Kaplan et al. (2020) found a trend. We replicate it.").length, 2);
});

test("太短 / 非英文文本：直接放弃估算，不硬给一个级别", () => {
  assert.equal(estimateCefr(["Hello"], allEasy), null);
  assert.equal(estimateCefr(["这是一篇完全由中文写成的文章，里面一个英文单词也没有。"], allEasy), null);
  assert.equal(
    estimateCefr([Array.from({ length: MIN_WORDS - 1 }, (_, i) => POOL[i % POOL.length]).join(" ")], allEasy),
    null,
  );
});

test("控制变量一：只改词汇难度，句子结构不变 → 复杂度分必须完全不动", () => {
  const parts = textFromWords(WORDS, 12);
  const easy = estimateCefr(parts, allEasy)!;
  const hard = estimateCefr(parts, allHard)!;

  assert.equal(easy.detail.complexity.score, hard.detail.complexity.score, "句法特征与词典无关");
  assert.equal(easy.detail.wordCount, hard.detail.wordCount);
  assert.equal(easy.detail.sentenceCount, hard.detail.sentenceCount);
  assert.ok(hard.detail.vocabulary.score > easy.detail.vocabulary.score);
  assert.ok(hard.score > easy.score);
  assert.ok(CEFR_LEVELS.indexOf(hard.level) > CEFR_LEVELS.indexOf(easy.level));
  assert.equal(easy.level, "A1");
  assert.equal(hard.level, "C1");
});

test("控制变量二：只改句子边界，词完全不变 → 词汇分必须完全不动", () => {
  const shortSent = estimateCefr(textFromWords(WORDS, 8), allEasy)!;
  const longSent = estimateCefr(textFromWords(WORDS, 30), allEasy)!;

  assert.equal(shortSent.detail.wordCount, longSent.detail.wordCount);
  assert.equal(shortSent.detail.vocabulary.score, longSent.detail.vocabulary.score, "同一个词集合不该因为断句变化");
  assert.equal(shortSent.detail.complexity.longSentenceRatio, 0);
  assert.equal(longSent.detail.complexity.longSentenceRatio, 1);
  assert.ok(longSent.detail.complexity.avgSentenceLength > shortSent.detail.complexity.avgSentenceLength);
  assert.ok(longSent.detail.complexity.score > shortSent.detail.complexity.score);
  assert.ok(longSent.score > shortSent.score);
});

test("控制变量三：未收录词变多 → 置信度下降、caveats 给出解释", () => {
  const parts = textFromWords(WORDS, 12);
  const known = estimateCefr(parts, allEasy)!;
  const unknown = estimateCefr(parts, () => null)!;

  assert.equal(known.confidence, "high");
  assert.equal(unknown.confidence, "low");
  assert.equal(unknown.detail.vocabulary.unlistedRatio, 1);
  assert.ok(unknown.detail.caveats.some((c) => c.includes("专有名词")));
  assert.equal(known.detail.caveats.length, 1, "没有偏差时只保留「粗估」这一条");
});

test("词汇三档占比之和恒为 1，未收录词按最生僻处理", () => {
  const r = estimateCefr(textFromWords(WORDS, 12), mixed)!;
  const { core, mid, advanced } = r.detail.vocabulary.bandRatios;
  assert.ok(Math.abs(core + mid + advanced - 1) < 0.001, `${core}+${mid}+${advanced}`);
  assert.ok(core > 0 && mid > 0 && advanced > 0);
  assert.ok(r.detail.vocabulary.coverage.top1000 > 0);
  assert.ok(r.detail.vocabulary.coverage.top8000 < 1);
});

test("最终分数 == 词汇分 × 0.7 + 复杂度分 × 0.3（四舍五入误差内）", () => {
  const r = estimateCefr(textFromWords(WORDS, 15), mixed)!;
  const expected =
    r.detail.weights.vocabulary * r.detail.vocabulary.score +
    r.detail.weights.complexity * r.detail.complexity.score;
  assert.ok(Math.abs(r.score - expected) < 0.02, `${r.score} vs ${expected}`);
  assert.equal(r.method, "heuristic-v1");
});

test("纯函数：同一输入重复估算结果完全一致（结果要落库，不能随环境漂）", () => {
  const parts = textFromWords(WORDS, 15);
  assert.deepEqual(estimateCefr(parts, mixed), estimateCefr(parts, mixed));
  assert.deepEqual(analyzeFeatures(parts, mixed), analyzeFeatures(parts, mixed));
});

test("asCefrLevel：数据库里被写坏的取值不能让页面崩", () => {
  assert.equal(asCefrLevel("B2"), "B2");
  assert.equal(asCefrLevel(null), null);
  assert.equal(asCefrLevel("Z9"), null);
  assert.equal(asCefrLevel(""), null);
});

test("parseCefrDetail：坏 JSON 不抛异常", () => {
  assert.equal(parseCefrDetail(null), null);
  assert.equal(parseCefrDetail(""), null);
  assert.equal(parseCefrDetail("{oops"), null);
  assert.equal(parseCefrDetail("null"), null);
  assert.deepEqual(parseCefrDetail('{"wordCount":42}'), { wordCount: 42 });
});

test("常量：COCA 排名上限与实际词典一致（改词典时这里会提醒重新校准）", () => {
  assert.equal(MAX_COCA_RANK, 47062);
});

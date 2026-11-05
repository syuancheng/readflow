/**
 * 文章 CEFR 难度「粗估」（heuristic-v1）。
 *
 * ── 为什么是「估」而不是「定级」──
 * CEFR 本来是描述「人」的能力框架（A1…C2），不是文本标准。
 * 分级读物（graded reader）是作者按词汇大纲 / 语法大纲 *写* 到某一级；
 * 我们做的是反过来：拿一篇任意文本，*测* 它大概需要什么水平才读得动。
 * 这是预测问题，不是认证。级别边界天然模糊，所以输出同时带连续分数、
 * 相邻级别、置信度和判定明细，前端措辞也必须承认是「粗略估计」。
 *
 * ── 两路特征（对齐 Readlang：导入时服务端算一次，前端只展示）──
 * 1. 词汇路（权重 0.7）：ECDICT 带 COCA 词频排名 frq（1 最常用，最大 47062）。
 *    一篇文本要读得动，绝大部分「词次」必须落在学习者已掌握的高频词里。
 *    用按词次加权的平均 log(排名) 衡量整体词汇难度，再用低频词占比抓长尾。
 *    取 log 是因为排名跨 4 个数量级，直接平均会被少数极生僻词拖飞。
 * 2. 复杂度路（权重 0.3）：平均句长、超长句（≥25 词）比例、从句 / 衔接标记比例。
 *    纯可读性公式（Flesch 等）单独预测 CEFR 只有 31–42% 准确率，
 *    所以这里只让它当修正项，不做主判据。
 *
 * 本模块是纯函数：不碰数据库、不依赖 Node 内置模块，方便单测。
 * 词典查询由调用方用 RankLookup 注入（服务端实现见 cefr-dict.ts）。
 */

export const CEFR_METHOD = "heuristic-v1";

export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
export const CEFR_LEVELS: readonly CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

export type CefrConfidence = "low" | "medium" | "high";
export const CONFIDENCE_LABEL: Record<CefrConfidence, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

/** COCA 词频排名上限。未收录的词按这个排名处理（等价于「最生僻」）。 */
export const MAX_COCA_RANK = 47062;
/** frq > 8000 视为 C1+ 词汇 */
export const RARE_RANK = 8000;
/** 超长句阈值（词） */
export const LONG_SENTENCE_WORDS = 25;
/** 少于这个词数不做估算：样本太小，任何统计都没意义 */
export const MIN_WORDS = 20;

/** 词频分档，前端弹层按这个顺序展示占比 */
export const VOCAB_BANDS = [
  { key: "core", label: "高频基础词", hint: "COCA 前 2,000", max: 2000 },
  { key: "mid", label: "中频进阶词", hint: "2,000–8,000", max: RARE_RANK },
  { key: "advanced", label: "低频 / 未收录", hint: "8,000 以外", max: Infinity },
] as const;
export type VocabBandKey = (typeof VOCAB_BANDS)[number]["key"];

export const SCORE_WEIGHTS = { vocabulary: 0.7, complexity: 0.3 } as const;
/** 6 个级别等分 0–100，每级约 16.67 分 */
export const LEVEL_BAND_WIDTH = 100 / CEFR_LEVELS.length;

/** 返回 COCA 词频排名（1…47062）；未收录返回 null。由调用方注入，见 cefr-dict.ts */
export type RankLookup = (word: string) => number | null;

export type CefrCoverage = { top1000: number; top3000: number; top8000: number };

export type CefrFeatures = {
  wordCount: number;
  sentenceCount: number;
  /** 按词次加权的平均 log(COCA 排名) */
  meanLogRank: number;
  /** rank > 8000（含未收录）的词次占比 */
  rareRatio: number;
  /** 词典里查不到排名的词次占比：专有名词 / 术语 / 公式符号都落在这里 */
  unlistedRatio: number;
  bandRatios: Record<VocabBandKey, number>;
  coverage: CefrCoverage;
  avgSentenceLength: number;
  longSentenceRatio: number;
  subordinateRatio: number;
};

export type CefrDetail = {
  wordCount: number;
  sentenceCount: number;
  /** 也存进 JSON：徽章直接从 detail 读，不必再单独加一列 */
  confidence: CefrConfidence;
  vocabulary: {
    meanLogRank: number;
    rareRatio: number;
    unlistedRatio: number;
    bandRatios: Record<VocabBandKey, number>;
    coverage: CefrCoverage;
    score: number;
  };
  complexity: {
    avgSentenceLength: number;
    longSentenceRatio: number;
    subordinateRatio: number;
    score: number;
  };
  weights: { vocabulary: number; complexity: number };
  /** 判定说明与已知偏差，直接给 UI 展示，避免「一个字母假装很精确」 */
  caveats: string[];
};

export type CefrResult = {
  level: CefrLevel;
  /** 0–100 连续分，保留精度，算法升级后可重算 */
  score: number;
  confidence: CefrConfidence;
  /** 分数贴近级别边界时给出相邻级别，例如 B2 但接近 C1 */
  adjacentLevel: CefrLevel | null;
  method: string;
  detail: CefrDetail;
};

const WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const SENT_SPLIT_RE = /[.!?…]+["'”’)\]]*\s+/;
/** 句末缩写：不该在这里断句，否则 "Dr. Smith" 会被算成两句 */
const ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
  "e.g", "i.e", "fig", "no", "vol", "approx", "inc", "u.s", "u.k",
  // 学术引用 / 论文里高频：一篇技术博客里 "et al." 能出现几十次，
  // 不合并的话会凭空多出几十个「短句」，把平均句长压低
  "al", "eq", "sec", "cf", "resp", "ibid", "eds",
]);
/** 从句 / 衔接标记。故意不含 that、if、as 这类高频兼类词，避免把简单句误判成长难句 */
const SUBORDINATE_RE =
  /\b(?:which|whom|whose|whereas|although|though|unless|whereby|wherein|whether|however|moreover|nevertheless|furthermore|consequently|therefore|despite|because|since|provided|assuming|albeit|notwithstanding)\b/i;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * 取英文单词，小写。
 * 单字母一律丢掉：LaTeX 变量（n / d / beta 里的 b）、人名首字母、
 * 列表编号都不是「词汇」，把它们当生僻词会严重高估技术文章难度。
 * 实测「Scaling Laws」那篇因此少了 685 个噪声 token。
 */
export function wordsOf(text: string): string[] {
  return (text.match(WORD_RE) ?? []).filter((w) => w.length > 1).map((w) => w.toLowerCase());
}

/**
 * 确定性切句：句末标点 + 空白，缩写结尾的片段与后一段合并。
 * 这里刻意不用 Intl.Segmenter —— 估级结果要落库，同一篇文章在不同 ICU
 * 版本下应该给出同一个值，纯正则最可靠。
 */
export function splitSentences(text: string): string[] {
  const frags = text.split(SENT_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let pending = "";

  for (const frag of frags) {
    const cur = pending ? `${pending} ${frag}` : frag;
    const last = cur.split(/\s+/).pop() ?? "";
    const stem = last.replace(/\.+$/, "");
    // "Dr." / "e.g." / "J." 后面不是句子边界
    if (ABBREV.has(stem.toLowerCase()) || /^[A-Z]$/.test(stem)) {
      pending = cur;
      continue;
    }
    out.push(cur);
    pending = "";
  }
  if (pending) out.push(pending);
  return out.filter((s) => wordsOf(s).length > 0);
}

/** 从原文提取两路特征。词数太少或非英文时返回 null（调用方应跳过估算）。 */
export function analyzeFeatures(parts: string[], rankOf: RankLookup): CefrFeatures | null {
  const text = parts.join("\n\n");
  const words = wordsOf(text);
  if (words.length < MIN_WORDS) return null;

  const ranks = words.map((w) => rankOf(w));
  const n = ranks.length;
  let logSum = 0;
  let rare = 0;
  let unlisted = 0;
  let c1000 = 0;
  let c3000 = 0;
  let c8000 = 0;
  let core = 0;
  let mid = 0;
  let advanced = 0;

  for (const r of ranks) {
    const rank = r ?? MAX_COCA_RANK;
    logSum += Math.log(Math.max(1, rank));
    if (r === null) unlisted++;
    if (rank > RARE_RANK) rare++;
    if (rank <= 1000) c1000++;
    if (rank <= 3000) c3000++;
    if (rank <= RARE_RANK) c8000++;
    if (rank <= VOCAB_BANDS[0].max) core++;
    else if (rank <= VOCAB_BANDS[1].max) mid++;
    else advanced++;
  }

  const sentences = splitSentences(text);
  const lens = sentences.map((s) => wordsOf(s).length);
  const sentenceCount = lens.length;

  return {
    wordCount: n,
    sentenceCount,
    meanLogRank: r4(logSum / n),
    rareRatio: r4(rare / n),
    unlistedRatio: r4(unlisted / n),
    bandRatios: { core: r4(core / n), mid: r4(mid / n), advanced: r4(advanced / n) },
    coverage: { top1000: r4(c1000 / n), top3000: r4(c3000 / n), top8000: r4(c8000 / n) },
    avgSentenceLength: r2(lens.reduce((a, b) => a + b, 0) / (sentenceCount || 1)),
    longSentenceRatio: r4(lens.filter((l) => l >= LONG_SENTENCE_WORDS).length / (sentenceCount || 1)),
    subordinateRatio: r4(sentences.filter((s) => SUBORDINATE_RE.test(s)).length / (sentenceCount || 1)),
  };
}

/** 0–100 分映射到 6 个等宽级别带 */
export function levelOfScore(score: number): CefrLevel {
  const i = Math.max(0, Math.min(CEFR_LEVELS.length - 1, Math.floor(score / LEVEL_BAND_WIDTH)));
  return CEFR_LEVELS[i];
}

/** 分数落在级别带边界 ±4 分内时，承认「可能是相邻一级」 */
export function adjacentOfScore(score: number): CefrLevel | null {
  const i = CEFR_LEVELS.indexOf(levelOfScore(score));
  const posInBand = score - i * LEVEL_BAND_WIDTH;
  const NEAR = 4;
  if (posInBand <= NEAR && i > 0) return CEFR_LEVELS[i - 1];
  if (LEVEL_BAND_WIDTH - posInBand <= NEAR && i < CEFR_LEVELS.length - 1) return CEFR_LEVELS[i + 1];
  return null;
}

/**
 * 置信度不是模型概率，而是「这批统计值可不可信」的工程判断：
 *   - 词太少 / 句太少 → 句法指标波动大
 *   - 未收录词太多 → 很可能混进了专有名词、代码、公式，词汇难度被高估
 */
export function confidenceOf(f: CefrFeatures): CefrConfidence {
  if (f.wordCount < 150 || f.sentenceCount < 8 || f.unlistedRatio > 0.25) return "low";
  if (f.wordCount >= 500 && f.sentenceCount >= 25 && f.unlistedRatio <= 0.1) return "high";
  return "medium";
}

function caveatsOf(f: CefrFeatures): string[] {
  const out = ["基于词汇难度与句子复杂度的粗略估计，不是 CEFR 官方评级"];
  if (f.wordCount < 150) out.push(`全文仅 ${f.wordCount} 词，句法统计波动大`);
  if (f.sentenceCount < 8) out.push("句子数太少，复杂度指标不稳定");
  if (f.unlistedRatio > 0.15) {
    out.push(
      `${pct(f.unlistedRatio)} 的词不在 COCA 前 ${MAX_COCA_RANK.toLocaleString()} 词内` +
        "（多为专有名词、术语、公式符号），难度可能被高估",
    );
  }
  return out;
}

/** 把特征值合成最终结论。所有阈值集中在这里，方便以后用标注数据重新校准。 */
export function scoreFeatures(f: CefrFeatures): CefrResult {
  // 词汇路：4.2≈rank 67（几乎全是功能词），7.0≈rank 1100（正文词汇已相当难）
  const logScore = clamp01((f.meanLogRank - 4.2) / 2.8) * 100;
  const rareScore = clamp01(f.rareRatio / 0.35) * 100;
  const vocabScore = 0.75 * logScore + 0.25 * rareScore;

  // 复杂度路：平均句长 8→0、28→100；超长句占比 35% 饱和；从句标记占比 50% 饱和
  const lenScore = clamp01((f.avgSentenceLength - 8) / 20) * 100;
  const longScore = clamp01(f.longSentenceRatio / 0.35) * 100;
  const subScore = clamp01(f.subordinateRatio / 0.5) * 100;
  const complexityScore = 0.5 * lenScore + 0.35 * longScore + 0.15 * subScore;

  const score = r2(SCORE_WEIGHTS.vocabulary * vocabScore + SCORE_WEIGHTS.complexity * complexityScore);
  const confidence = confidenceOf(f);

  return {
    level: levelOfScore(score),
    score,
    confidence,
    adjacentLevel: adjacentOfScore(score),
    method: CEFR_METHOD,
    detail: {
      wordCount: f.wordCount,
      sentenceCount: f.sentenceCount,
      confidence,
      vocabulary: {
        meanLogRank: f.meanLogRank,
        rareRatio: f.rareRatio,
        unlistedRatio: f.unlistedRatio,
        bandRatios: f.bandRatios,
        coverage: f.coverage,
        score: r2(vocabScore),
      },
      complexity: {
        avgSentenceLength: f.avgSentenceLength,
        longSentenceRatio: f.longSentenceRatio,
        subordinateRatio: f.subordinateRatio,
        score: r2(complexityScore),
      },
      weights: { ...SCORE_WEIGHTS },
      caveats: caveatsOf(f),
    },
  };
}

export function estimateCefr(parts: string[], rankOf: RankLookup): CefrResult | null {
  const features = analyzeFeatures(parts, rankOf);
  return features ? scoreFeatures(features) : null;
}

/** 数据库列是 TEXT，取值可能被手改坏；渲染前先收窄成联合类型 */
export function asCefrLevel(v: string | null | undefined): CefrLevel | null {
  return v && (CEFR_LEVELS as readonly string[]).includes(v) ? (v as CefrLevel) : null;
}

/** 数据库里存的是 JSON 字符串；坏数据不能让整个页面挂掉 */
export function parseCefrDetail(raw: string | null | undefined): CefrDetail | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as CefrDetail) : null;
  } catch {
    return null;
  }
}

/**
 * 按情况截取 AI 释义的上下文（对齐并小幅超越 Readlang 的句子级设计）：
 *
 * - 单词 / 短语（未覆盖整句）：前文、后文都截到所在句子的边界
 *   —— 即 Readlang 的「整句上下文」，保证句子主语完整，不被锚点窗口截断
 * - 划了完整一句（或多句）：选区本身已是完整句子，前文/后文各给相邻一句，补语境
 * - 「没看懂整句」信号（李笑来式阅读法的落地）：选区覆盖了句子的 ≥75% 词汇，
 *   或该句 ≥8 词且其中 ≥75% 是用户已收进词库的生词 —— 说明用户卡的是整句，
 *   前文额外带上上一句（跨段时取前一段最后一句），用于理解指代与句间衔接
 *
 * 句子切分用 Intl.Segmenter（正确处理 Mr. / e.g. / 引号等，替代手写正则）。
 * 仅在浏览器事件回调中调用（点词/划选时），不参与 SSR 渲染，无 hydration 风险。
 */

type Span = { start: number; end: number };

/** 段落按句子切分，返回每句的字符区间。环境不支持时退化为简单正则。 */
export function splitSentences(text: string): Span[] {
  if (text.length === 0) return [{ start: 0, end: 0 }];

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    return [...seg.segment(text)].map((s) => ({
      start: s.index,
      end: s.index + s.segment.length,
    }));
  }

  // 兜底：老环境没有 Segmenter，用朴素句末标点切分（够用，但不识别缩写）
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(/[^\n]+/g)) {
    const lineStart = m.index!;
    let s = lineStart;
    for (const sm of m[0].matchAll(/[^.!?…]*[.!?…]+["')\]]*\s*/g)) {
      const segStart = lineStart + sm.index!;
      if (segStart + sm[0].length > s) {
        out.push({ start: s, end: segStart + sm[0].length });
        s = segStart + sm[0].length;
      }
    }
    if (s < lineStart + m[0].length) out.push({ start: s, end: lineStart + m[0].length });
    last = lineStart + m[0].length;
  }
  return out.length ? out : [{ start: 0, end: text.length }];
}

/** 提取一段文本里的英文单词（小写），用于词数/生词密度统计 */
function wordsOf(text: string): string[] {
  return [...text.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)].map((m) => m[0].toLowerCase());
}

export type SelectionKind = "word" | "phrase" | "sentence";

/**
 * 选区三分类（几何信号，纯函数，可单测）：
 * - word    单个词（无空白）
 * - phrase  短语（多词，但不是完整句子）
 * - sentence 句子：以句末标点（.!?…，可带引号/括号收尾）结束；
 *   或 ≥15 词的超长选区——没标点也按长难句处理（多从句、无标点截选）
 *
 * 注意：新版 AI 释义不再用它决定输出模板（那会让同一个动作得到不同人格）。
 * 它现在只作为客观证据之一交给模型，或供其他需要粗分类的链路使用。
 */
export function selectionKind(text: string): SelectionKind {
  const t = text.trim();
  if (!t || !/\s/.test(t)) return "word";
  if (/[.!?…]["'”’)\]]*$/.test(t)) return "sentence";
  if (wordsOf(t).length >= 15) return "sentence";
  return "phrase";
}

export type AIContext = {
  prefix: string;
  suffix: string;
  /** 前文包含了上一句（触发「没看懂整句」信号时为 true，前端据此给模型加提示语） */
  withPrevSentence?: boolean;
};

/**
 * 计算发给 AI 的前文/后文。
 * @param paragraph  选区所在段落的完整文本
 * @param start/end  选区在段落内的字符区间
 * @param opts.savedSet      用户已收词集合（小写词形/词元），用于生词密度判定
 * @param opts.prevParagraph 上一段全文（选区在段首时，上一句要从前一段取）
 */
export function aiContextOf(
  paragraph: string,
  start: number,
  end: number,
  opts?: { savedSet?: Set<string>; prevParagraph?: string }
): AIContext {
  const s = Math.max(0, Math.min(start, paragraph.length));
  const e = Math.max(s, Math.min(end, paragraph.length));

  const sentences = splitSentences(paragraph);
  // 与选区重叠的句子集合 [s0, s1]
  let s0 = -1;
  let s1 = -1;
  sentences.forEach((sn, i) => {
    if (sn.end > s && sn.start < e) {
      if (s0 < 0) s0 = i;
      s1 = i;
    }
  });
  if (s0 < 0) {
    // 选区落在句子间隙（理论上不会）：退化为段落级
    return { prefix: paragraph.slice(0, s), suffix: paragraph.slice(e) };
  }

  const coreStart = sentences[s0].start;
  const coreEnd = sentences[s1].end;
  const core = paragraph.slice(coreStart, coreEnd);
  const coreWords = wordsOf(core);
  const selWords = wordsOf(paragraph.slice(s, e));
  const coverage = coreWords.length > 0 ? selWords.length / coreWords.length : 1;

  // 「没看懂整句」信号之一：句中生词密度（仅 ≥8 词的长句判定，避免短句误触发）
  const savedSet = opts?.savedSet;
  const density =
    savedSet && coreWords.length >= 8
      ? coreWords.filter((w) => savedSet.has(w)).length / coreWords.length
      : 0;

  // 上一句文本（段内取前一句；段首则取前一段最后一句），取不到为空串
  const prevSentence = s0 > 0
    ? paragraph.slice(sentences[s0 - 1].start, sentences[s0 - 1].end)
    : opts?.prevParagraph
      ? lastSentenceOf(opts.prevParagraph)
      : "";

  // 选区覆盖了所在句 ≥75% 词汇：视为「划了整句/大半句」→ 前后取相邻句补语境
  if (coverage >= 0.75 && coreWords.length > 0) {
    const nextEnd = s1 + 1 < sentences.length ? sentences[s1 + 1].end : coreEnd;
    const pre = prevSentence.trim();
    return {
      prefix: pre ? `${pre} ${paragraph.slice(coreStart, s)}`.trim() : paragraph.slice(coreStart, s),
      suffix: paragraph.slice(e, nextEnd),
      withPrevSentence: Boolean(pre),
    };
  }

  // 单词/短语：前后文截到句子边界（整句上下文，对齐 Readlang）
  const base: AIContext = {
    prefix: paragraph.slice(coreStart, s),
    suffix: paragraph.slice(e, coreEnd),
  };

  // 未盖满整句，但生词密度 ≥75%：用户卡的是整句 → 前文额外带上上一句
  if (density >= 0.75) {
    const pre = prevSentence.trim();
    if (pre) {
      return {
        prefix: `${pre} ${base.prefix}`.trim(),
        suffix: base.suffix,
        withPrevSentence: true,
      };
    }
  }

  return base;
}

/** 取一段文本的最后一个句子（用于跨段取「上一句」） */
function lastSentenceOf(text: string): string {
  const spans = splitSentences(text);
  if (spans.length === 0) return "";
  const last = spans[spans.length - 1];
  return text.slice(last.start, last.end);
}

/**
 * 阅读器采集的客观信号，随释义请求送给模型。
 *
 * 设计原则（2026-11-05 讨论收敛）：
 * - 前端只送「证据」，不送「结论」。判断选区是不是主干、该给多深的答案，是老师的本职。
 * - 这些字段都不依赖模型的二次分类，也不落库；`splitSentences()` 的句子区间顺带用来
 *   给「同一句连续请教」计数做 key。
 * - 只在浏览器事件回调里调用，不参与 SSR 渲染，避免 ICU 差异导致 hydration mismatch。
 */
export type SelectionSignals = {
  /** 点词还是拖选 */
  source: "word" | "select";
  /** 选区词数 */
  selectionWords: number;
  /** 选区所在句的完整原文（跨句选区会合并，供句子地图标注） */
  sentence: string;
  /** 所在句词数 */
  sentenceWords: number;
  /** 选区覆盖所在句的词汇比例，0..1 */
  coverage: number;
  /** 选区在句中的位置（粗证据：句首常是主语/状语，句中常是谓语） */
  position: "start" | "middle" | "end";
  /** 所在句在段落内的字符区间 */
  sentenceStart: number;
  sentenceEnd: number;
  /** 同一句内连续请教的次数（会话内累计，不落库；含词典命中与 AI 释义，只要选了就算） */
  repeatCount?: number;
  /** 同一句之前问过的选区文本（会话内累计，不落库）。
   *  只存选区原文，不存 AI 生成内容——模型需要的是「他问过什么」这个事实，
   *  不是上一轮的完整释义文本。priorAsks.length = repeatCount - 1（不含本次）。 */
  priorAsks?: { selection: string }[];
  /** 词典是否收录选区（短语通常查不到） */
  dictHit?: boolean;
};

/** 计算一次选区的客观信号。确定性纯函数，可单测。 */
export function selectionSignals(
  paragraph: string,
  start: number,
  end: number,
  source: "word" | "select",
): SelectionSignals {
  const s = Math.max(0, Math.min(start, paragraph.length));
  const e = Math.max(s, Math.min(end, paragraph.length));
  const sentences = splitSentences(paragraph);

  let first = -1;
  let last = -1;
  sentences.forEach((span, i) => {
    if (span.end > s && span.start < e) {
      if (first < 0) first = i;
      last = i;
    }
  });
  const span =
    first >= 0
      ? { start: sentences[first].start, end: sentences[last].end }
      : { start: s, end: e };

  const sentence = paragraph.slice(span.start, span.end);
  const sentenceWords = wordsOf(sentence).length;
  const selectionWords = wordsOf(paragraph.slice(s, e)).length;
  const coverage = sentenceWords > 0 ? Math.min(1, selectionWords / sentenceWords) : 1;
  const rel = span.end > span.start ? (s - span.start) / (span.end - span.start) : 0;
  const position = rel < 0.25 ? "start" : rel > 0.75 ? "end" : "middle";

  return {
    source,
    selectionWords,
    sentence,
    sentenceWords,
    coverage,
    position,
    sentenceStart: span.start,
    sentenceEnd: span.end,
  };
}

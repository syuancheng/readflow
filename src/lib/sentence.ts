/**
 * 按情况截取 AI 释义的上下文（2026-11-19 起为两层结构，见 contextLayersOf）：
 *
 * - 第一层「所在句」：选区所在句子的完整原文，是词义 / 搭配 / 句法判断的对象；
 * - 第二层「近前文」：所在句之前最多 150 词，按句边界切、跨段往前取、倒序排列，
 *   只用来理解指代 / 承接 / 省略；段首的 Woman: / Man: 标签随原文保留。
 *
 * 两层都只依赖段落原文 + 选区锚点，不读 savedSet 等可变状态——保证同一条批注
 * 每轮追问算出的内容逐字相同，放进 system 才能命中模型前缀缓存。
 *
 * 句子切分用确定性的正则 + 缩写白名单，不用 Intl.Segmenter。
 * Segmenter 在两个方向都错（实测 ICU）：
 *   ① "harness. pi comes" → 把小写 pi 当缩写，整段不切（线上锚点混入上一句的根因）；
 *   ② "Mr. Brown." / "The U.S. President." → 把真缩写后接的大写词切成新句，
 *      人名/机构名被拦腰截断。
 * 正则不依赖 ICU 版本，服务端与浏览器结果一致，也无 hydration 风险。
 */

type Span = { start: number; end: number };

/**
 * 句号跟在以下词后面时不算句子边界。只收「不带内部点」的缩写；
 * 带内部点的（e.g. / U.S. / Ph.D. / J.R.R. / a.m.）由 isAbbreviation 的含点规则覆盖。
 *
 * 刻意不放高频普通词（us / in / he / it / the ...）：放进去会把真句子漏切。
 * 缩写后接大写词（Mr. Smith / U.S. President）也必须靠这张表挡住，不能只看大小写。
 */
const ABBREVIATIONS = new Set([
  // 称谓、头衔、人名前缀
  "mr", "mrs", "ms", "miss", "dr", "prof", "sr", "jr", "st", "mt",
  "hon", "rev", "gen", "col", "capt", "lt", "sgt", "gov", "sen", "rep",
  "pres", "fr", "br", "pr", "bro", "supt", "dir", "asst", "assoc", "adm", "maj",
  // 拉丁语与学术通用缩写
  "etc", "vs", "v", "viz", "cf", "approx", "appr", "est", "et", "al",
  "id", "ibid", "sc", "nl", "seq", "ca",
  // 机构、地址、编号
  "inc", "ltd", "co", "corp", "dept", "univ", "assn", "inst", "no", "nos",
  "ave", "blvd", "rd", "pl", "bldg", "ste",
  // 引用、计量、学位
  "fig", "eq", "chap", "sec", "p", "pp", "vol", "ed", "eds", "trans",
  "ref", "refs", "fn", "oz", "lb", "ft", "kg", "km", "hr", "min",
  "phd", "md", "ba", "ma", "bs", "ms", "mba", "jd", "llm", "llb", "dds", "dvm", "edd",
  // 月份、星期（常以缩写点出现）
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
]);

/** 取标点前紧邻的一个词；允许内部点，以便识别 e.g / U.S / Ph.D / J.R.R */
function wordBefore(text: string): string | null {
  const m = text.match(/([A-Za-z]+(?:\.[A-Za-z]+)*)$/);
  return m ? m[1] : null;
}

function isAbbreviation(token: string): boolean {
  // 带内部点的几乎都是缩写（e.g / i.e / U.S / Ph.D / a.m / J.R.R）；
  // 版本号、IP、小数点的点后面是数字，匹配不到 wordBefore 的字母模式
  if (token.includes(".")) return true;
  return ABBREVIATIONS.has(token.toLowerCase());
}

/**
 * 缩写后的句号默认不是句子边界，但「缩写 + 大写句首词」是明确的新句：
 *   "etc. Then stopped." / "Ph.D. Then she left." / "p.m. Tomorrow we leave."
 * 而 "Mr. Brown" / "U.S. President" / "vs. B" 的大写词是名字或代号，不在表里，
 * 因此仍被当作缩写的一部分不切开。
 */
const SENTENCE_STARTERS = new Set([
  "then", "now", "later", "next", "after", "before", "finally", "first", "second",
  "we", "he", "she", "it", "they", "i", "you",
  "this", "that", "these", "those",
  "but", "and", "so", "however", "therefore", "thus", "hence", "moreover",
  "besides", "also", "still", "yet", "instead", "otherwise", "meanwhile",
  "in", "on", "at", "for", "from", "with", "as", "if", "when", "while",
  "because", "although", "though", "overall", "tomorrow", "yesterday", "today",
  "one", "another", "the", "there", "here",
]);

/**
 * 句末标点 + 可跟随的收尾引号/括号 + 空白（或全文结束）。
 * 小数点后的数字不会被匹配，因为点后面不是空白；URL 中的点同理。
 */
const SENT_END_RE = /[.!?…]+["'”’)\]]*(?:\s+|$)/g;

/** 段落按句子切分，返回每句的字符区间（连续、不重叠、覆盖全文）。 */
export function splitSentences(text: string): Span[] {
  if (text.length === 0) return [{ start: 0, end: 0 }];

  const out: Span[] = [];
  let cursor = 0;
  SENT_END_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = SENT_END_RE.exec(text)) !== null) {
    // before 从 cursor 起算：缩写被跳过后 cursor 不动，末词判断仍然落在标点前那一个词
    const before = text.slice(cursor, m.index);
    if (!before.trim()) continue; // 连续标点（"?!..."）不单独成句
    const end = m.index + m[0].length;
    const word = wordBefore(before);
    if (word && isAbbreviation(word)) {
      // 缩写后跟「大写句首词」才是一条真新句；否则（Mr. Brown / U.S. President）不切
      const next = text.slice(end).match(/^\s*([A-Z][A-Za-z]*)/);
      if (!(next && SENTENCE_STARTERS.has(next[1].toLowerCase()))) continue;
    }

    out.push({ start: cursor, end });
    cursor = end;
  }

  if (cursor < text.length) out.push({ start: cursor, end: text.length });
  return out.length ? out : [{ start: 0, end: text.length }];
}

/** 提取一段文本里的英文单词（小写），用于词数/生词密度统计 */
export function wordsOf(text: string): string[] {
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

/**
 * 两层上下文（2026-11-19 定稿）。
 *
 * 第一层「所在句」= 学生选中的词/短语直接所在的那句，是词义、搭配、句法判断的对象；
 * 第二层「近前文」= 所在句之前最多 150 词的语境，按句边界切、跨段继续往前取、倒序排列，
 * 只用来理解指代 / 承接 / 省略（that / it / the one 指什么），不是学生选中的内容。
 *
 * 两层都只由「段落原文 + 选区锚点」决定，不读 savedSet 之类的可变状态——
 * 同一条批注的每一轮追问算出来的内容逐字相同，放进 system 才能命中模型前缀缓存。
 */
/** 近前文的最大词数（按句边界截断，最后一句可能让总量略超） */
export const NEAR_CONTEXT_MAX_WORDS = 150;
/** 兜底：近前文最多这么多句，防止极端短句把请求体撑爆 */
export const NEAR_CONTEXT_MAX_SENTENCES = 80;

export type ContextLayers = {
  /** 第一层：选区所在的完整句子 */
  sentence: string;
  /** 第二层：所在句之前的句子，离所在句最近的排最前（倒序） */
  nearContext: string[];
};

/**
 * 计算两层上下文。
 * @param paragraphs 全文段落（按 idx 顺序），每项至少有 content
 * @param paraIdx    选区所在段落在数组里的下标
 * @param start/end  选区在段落内的字符区间
 */
export function contextLayersOf(
  paragraphs: readonly { content: string }[],
  paraIdx: number,
  start: number,
  end: number,
): ContextLayers {
  if (paraIdx < 0 || paraIdx >= paragraphs.length) return { sentence: "", nearContext: [] };
  const content = paragraphs[paraIdx].content;
  const s = Math.max(0, Math.min(start, content.length));
  const e = Math.max(s, Math.min(end, content.length));

  const sentences = splitSentences(content);
  let first = -1;
  let last = -1;
  sentences.forEach((sn, i) => {
    if (sn.end > s && sn.start < e) {
      if (first < 0) first = i;
      last = i;
    }
  });
  // 选区落在句子间隙（理论上不会）：退化成把选区本身当所在句
  const coreStart = first >= 0 ? sentences[first].start : s;
  const coreEnd = last >= 0 ? sentences[last].end : e;
  const sentence = content.slice(coreStart, coreEnd).trim();

  const nearContext: string[] = [];
  let words = 0;
  const take = (text: string): boolean => {
    const t = text.trim();
    if (!t) return false;
    nearContext.push(t);
    words += wordsOf(t).length;
    return words >= NEAR_CONTEXT_MAX_WORDS || nearContext.length >= NEAR_CONTEXT_MAX_SENTENCES;
  };

  // 本段：所在句之前的句子，从近到远
  for (let i = first >= 0 ? first - 1 : -1; i >= 0; i--) {
    if (take(content.slice(sentences[i].start, sentences[i].end))) {
      return { sentence, nearContext };
    }
  }
  // 跨段：前一段的最后一句开始，继续倒着往前取；段首的 Woman: / Man: 标签随原文保留
  for (let p = paraIdx - 1; p >= 0; p--) {
    const prev = paragraphs[p].content;
    const spans = splitSentences(prev);
    for (let i = spans.length - 1; i >= 0; i--) {
      if (take(prev.slice(spans[i].start, spans[i].end))) {
        return { sentence, nearContext };
      }
    }
  }
  return { sentence, nearContext };
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

/**
 * P57b：句子窗口——v2 提示词的「上下文层」（L3）。
 *
 * 三段，按原文顺序：
 *   前文    所在句之前的句子，累计约 150 词，整句取；可以跨到上一段（段首的句子常要靠上一段末尾才懂指代）
 *   所在句  选区所在的完整句（跨句选区合并成连续几句），是要讲的对象
 *   后一句  只取**同一段里**紧接着的一句；所在句已是段末就没有，不去下一段拿
 *
 * 只由「段落原文 + 选区位置」决定，不读任何会变的状态：同一句里点不同的词、对同一条批注追问，
 * 窗口逐字相同，前缀缓存才能共用。每一段都有字符上限，不会因为某段没有句号而把几千词塞进来。
 *
 * 纯函数，只用相对路径 import（前后端与单测共用）。
 */
import { contextLayersOf, splitSentences } from "../sentence";

/** 所在句最多这么多字符（极端的超长句按字符截断） */
export const SENTENCE_MAX_CHARS = 1500;
/** 后一句、前文里的每一句各自的上限 */
export const NEIGHBOR_MAX_CHARS = 600;

export type SentenceWindow = {
  /** 前文，原文顺序，句与句之间用空格，段与段之间用空行；没有则为空串 */
  prev: string;
  /** 所在句 */
  sentence: string;
  /** 同段后一句；没有则为空串 */
  next: string;
};

type Para = { content: string };

const clip = (text: string, max: number): string => {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
};

export function sentenceWindowOf(
  paragraphs: readonly Para[],
  paraIdx: number,
  start: number,
  end: number,
): SentenceWindow {
  if (paraIdx < 0 || paraIdx >= paragraphs.length) return { prev: "", sentence: "", next: "" };
  // 所在句与前文（倒序）沿用已有算法；这里只调整成原文顺序并加上字符上限
  const layers = contextLayersOf(paragraphs, paraIdx, start, end);
  const prev = [...layers.nearContext].reverse().map((s) => clip(s, NEIGHBOR_MAX_CHARS)).join(" ");

  // 同段后一句：选区最后覆盖的那句之后紧接着的一句
  const content = paragraphs[paraIdx].content;
  const e = Math.max(0, Math.min(end, content.length));
  const spans = splitSentences(content);
  let last = -1;
  spans.forEach((sn, i) => {
    if (sn.end > Math.min(start, e) && sn.start < Math.max(e, start + 1)) last = i;
  });
  const nextSpan = last >= 0 ? spans[last + 1] : undefined;
  const next = nextSpan ? clip(content.slice(nextSpan.start, nextSpan.end), NEIGHBOR_MAX_CHARS) : "";

  return { prev, sentence: clip(layers.sentence, SENTENCE_MAX_CHARS), next };
}

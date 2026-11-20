/**
 * P57b：段落窗口——v2 提示词的「段落层」（L3）。
 *
 * 目标：同一段里无论点哪一句、哪一个词，窗口逐字相同，前缀缓存才能共用。
 * 所以它只由「段落原文」决定，不读选区位置之外的任何状态；而且**按固定网格取块**，
 * 而不是以所在句为中心滑动。
 *
 * - 段落不长（≤ WINDOW_WHOLE_MAX_WORDS 词）：整段，加上前面各段末尾约 150 词（原文顺序）。
 * - 段落很长：从段首起每约 CHUNK_WORDS 词一块（句边界对齐，只由段落原文决定），
 *   取「含所在句的块」及其前后各一块。同一个块里的点击窗口完全相同。
 *   窗口不从段首开始时，前面的内容已经在上一块里，不再取前面各段。
 * - 不跨段取后文：窗口里的「后文」只来自本段，避免依赖下一段是什么。
 *
 * 纯函数，只用相对路径 import（前后端与单测共用）。
 */
import { NEAR_CONTEXT_MAX_WORDS, splitSentences, wordsOf } from "../sentence";

/** 整段放入的上限（词）；超过就按网格切块 */
export const WINDOW_WHOLE_MAX_WORDS = 300;
/** 网格块大小（词，按整句累加到不少于这个数就收一块） */
export const CHUNK_WORDS = 120;

export type ParagraphWindow = {
  /** 前面各段的末尾（约 150 词，整句，原文顺序）；窗口不从段首开始时为空 */
  prevTail: string;
  /** 当前段落（或长段落里的三块） */
  body: string;
  /** 选区所在的完整句（跨句选区合并），只在尾部引用，不进缓存层 */
  sentence: string;
};

type Para = { content: string };

export function paragraphWindowOf(
  paragraphs: readonly Para[],
  paraIdx: number,
  start: number,
  end: number,
): ParagraphWindow {
  if (paraIdx < 0 || paraIdx >= paragraphs.length) return { prevTail: "", body: "", sentence: "" };
  const content = paragraphs[paraIdx].content;
  const s = Math.max(0, Math.min(start, content.length));
  const e = Math.max(s, Math.min(end, content.length));
  const spans = splitSentences(content);

  // 选区覆盖的句子下标范围
  let first = -1;
  let last = -1;
  spans.forEach((sn, i) => {
    if (sn.end > s && sn.start < e) {
      if (first < 0) first = i;
      last = i;
    }
  });
  const coreStart = first >= 0 ? spans[first].start : s;
  const coreEnd = last >= 0 ? spans[last].end : e;
  const sentence = content.slice(coreStart, coreEnd).trim();

  const totalWords = wordsOf(content).length;
  if (totalWords <= WINDOW_WHOLE_MAX_WORDS || spans.length === 0) {
    return { prevTail: prevTailOf(paragraphs, paraIdx), body: content.trim(), sentence };
  }

  // 长段落：固定网格
  const chunks: { from: number; to: number }[] = []; // 句子下标区间 [from, to]
  let from = 0;
  let words = 0;
  spans.forEach((sn, i) => {
    words += wordsOf(content.slice(sn.start, sn.end)).length;
    if (words >= CHUNK_WORDS || i === spans.length - 1) {
      chunks.push({ from, to: i });
      from = i + 1;
      words = 0;
    }
  });
  const chunkOf = (sentenceIdx: number) => chunks.findIndex((c) => sentenceIdx >= c.from && sentenceIdx <= c.to);
  const ci = Math.max(0, chunkOf(first >= 0 ? first : 0));
  const cj = Math.max(ci, chunkOf(last >= 0 ? last : 0));
  const lo = Math.max(0, ci - 1);
  const hi = Math.min(chunks.length - 1, cj + 1);
  const body = content.slice(spans[chunks[lo].from].start, spans[chunks[hi].to].end).trim();
  return { prevTail: lo === 0 ? prevTailOf(paragraphs, paraIdx) : "", body, sentence };
}

/** 前面各段的末尾，累计约 NEAR_CONTEXT_MAX_WORDS 词，整句取；各段之间空一行，原文顺序 */
function prevTailOf(paragraphs: readonly Para[], paraIdx: number): string {
  const segments: string[] = [];
  let words = 0;
  for (let p = paraIdx - 1; p >= 0 && words < NEAR_CONTEXT_MAX_WORDS; p--) {
    const prev = paragraphs[p].content;
    const spans = splitSentences(prev);
    if (spans.length === 0) {
      const t = prev.trim();
      if (t) {
        segments.unshift(t);
        words += wordsOf(t).length;
      }
      continue;
    }
    let fromIdx = spans.length;
    for (let i = spans.length - 1; i >= 0 && words < NEAR_CONTEXT_MAX_WORDS; i--) {
      fromIdx = i;
      words += wordsOf(prev.slice(spans[i].start, spans[i].end)).length;
    }
    const piece = prev.slice(spans[fromIdx].start).trim();
    if (piece) segments.unshift(piece);
  }
  return segments.join("\n\n");
}

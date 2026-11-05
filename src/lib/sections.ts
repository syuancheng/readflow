/**
 * 分段小结（section summary）的分区逻辑。
 *
 * 核心约束（用户明确要求）：**绝不能把一个自然段拆开**——小结标记只能落在
 * 自然段结束的地方。所以这里只做「整段累加」，绝不做句子/字符级切分。
 *
 * 为什么按词数而不是按段数：英语写作里一段的长度差异极大——
 * 新闻一段 25~50 词，网页文章 40~80 词，学术写作 100~200 词，能差 8 倍。
 * 按「每 N 段」切会让某些区间只有几句话、另一些区间有十句以上。
 * 因此按累计词数切：累加到 ≥ 目标词数，就在当前段末尾截断。
 */

/** 每个区间累计到多少词后截断（约 4 分钟阅读量） */
export const SECTION_TARGET_WORDS = 300;

/**
 * 文末残余区间的下限：最后剩下的段落总词数不足这个数时，
 * 并入上一个区间，避免出现「只有一句话、没什么可总结」的尾部标记。
 */
export const SECTION_TAIL_MIN_WORDS = 120;

export type SectionPara = { idx: number; content: string };

export type Section = {
  /** 区间起始段落 idx（含） */
  startIdx: number;
  /** 区间结束段落 idx（含）——标记落在这个自然段之后 */
  endIdx: number;
  /** 区间累计词数 */
  words: number;
  /** 区间段落数 */
  count: number;
};

/** 英文词数：字母/数字串，连字符与撇号算同一个词（don't / well-known） */
export function countWords(text: string): number {
  return (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
}

/**
 * 把段落划分成若干小结区间。
 *
 * 规则：
 * 1. 从上一个标记（或文章开头）开始逐段累加词数；
 * 2. 累加后 ≥ targetWords → 在当前段**末尾**截断并放标记；
 * 3. 单段本身就超过目标词数 → 它自成一个区间（绝不切段）；
 * 4. 文末残余不足 tailMinWords → 并入上一区间（只有 1 个区间时除外）。
 *
 * 段落数 < 2 时返回空数组：单段文章没有「区间」可言，放标记纯属噪音。
 */
export function planSections(
  paragraphs: SectionPara[],
  opts: { targetWords?: number; tailMinWords?: number } = {},
): Section[] {
  const target = opts.targetWords ?? SECTION_TARGET_WORDS;
  const tailMin = opts.tailMinWords ?? SECTION_TAIL_MIN_WORDS;

  const list = [...paragraphs].sort((a, b) => a.idx - b.idx);
  if (list.length < 2) return [];

  const sections: Section[] = [];
  let startIdx = list[0].idx;
  let words = 0;
  let count = 0;

  for (const p of list) {
    // count === 0 表示上一段刚好截断，这一段是新区间的第一段
    if (count === 0) startIdx = p.idx;
    words += countWords(p.content);
    count += 1;
    // 只在段末截断——自然段永远不拆
    if (words >= target) {
      sections.push({ startIdx, endIdx: p.idx, words, count });
      words = 0;
      count = 0;
    }
  }

  // 尾部残余
  if (count > 0) {
    const last = sections[sections.length - 1];
    if (last && words < tailMin) {
      // 并入上一区间：标记后移到最后一段，区间不断裂
      last.endIdx = list[list.length - 1].idx;
      last.words += words;
      last.count += count;
    } else {
      sections.push({ startIdx, endIdx: list[list.length - 1].idx, words, count });
    }
  }

  return sections;
}

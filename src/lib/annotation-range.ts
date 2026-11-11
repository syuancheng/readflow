/** 一条已存批注在正文里的字符区间（段落 uuid + 段内 [start, end)） */
export type AnnotationRange = {
  paragraphId: string;
  start: number;
  end: number;
};

/**
 * 这个词 / 词间空白落在哪条已存批注里。
 *
 * 命中条件：同段落，且批注区间**完整包住** [s, en)。只相邻或部分重叠不算，
 * 否则点短语前后的词也会误触发回看。多条批注重叠时取「区间最短、起点最早」
 * 的一条 —— 最短的那条最贴近用户当前指的位置。
 */
export function findCoveringRange<T extends AnnotationRange>(
  ranges: readonly T[],
  pid: string,
  s: number,
  en: number,
): T | undefined {
  return ranges
    .filter((r) => r.paragraphId === pid && r.start <= s && en <= r.end)
    .sort((x, y) => x.end - x.start - (y.end - y.start) || x.start - y.start)[0];
}

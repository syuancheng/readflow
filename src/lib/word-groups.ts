/**
 * 词库按文章分组（P51）。纯函数，只用相对路径 import。
 * 「全部文章」视图里，原来每行都重复一列被截断的文章标题；现在改成一个文章一个分组标题。
 * 分组顺序 = 每篇文章里第一个词在列表中出现的顺序，所以按「最近查的」排序时，最近读的那篇在最上面；
 * 组内保持传入的顺序（调用方已经按所选排序排好）。
 */
export type WordGroup<T> = { key: string; title: string; items: T[] };

export function groupByArticle<T extends { articleKey: string | null }>(
  items: readonly T[],
  titleOf: (key: string | null) => string,
): WordGroup<T>[] {
  const groups = new Map<string, WordGroup<T>>();
  for (const it of items) {
    const key = it.articleKey ?? "";
    let g = groups.get(key);
    if (!g) {
      g = { key, title: titleOf(it.articleKey), items: [] };
      groups.set(key, g);
    }
    g.items.push(it);
  }
  return [...groups.values()];
}

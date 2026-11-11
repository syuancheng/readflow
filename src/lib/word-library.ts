/**
 * 词库页（P27）的归类与导出状态 —— 纯函数，页面和单测共用。
 *
 * 1. 一个词只归到「最近查它的那篇文章」：按文章筛选时不重复出现，
 *    原句也只展示那篇文章里的（最多 3 条，最新在前）。
 * 2. 导出状态按卡片应用汇总（墨墨，以后 Anki / Quizlet…）：
 *    任一种卡片导出成功就算「已导出」，标签注明应用和卡片类型。
 */
import { CARD_TYPES } from "./cardgen";

/** 文章已删除的词统一归到这个键 */
export const DELETED_ARTICLE = "__deleted__";

export type CtxLike = {
  textId: string | null;
  textTitle: string | null;
  createdAt: number;
};

export type ArticleRef = { key: string; title: string; deleted: boolean };

/** 词归属的文章 = 最近一条语境所在的文章；没有语境返回 null */
export function latestArticle(ctxs: readonly CtxLike[]): ArticleRef | null {
  let best: CtxLike | null = null;
  for (const c of ctxs) if (!best || c.createdAt > best.createdAt) best = c;
  if (!best) return null;
  if (!best.textId || !best.textTitle) return { key: DELETED_ARTICLE, title: "已删除的文章", deleted: true };
  return { key: best.textId, title: best.textTitle, deleted: false };
}

/** 要展示的原句：只取归属文章里的语境，最新在前，最多 limit 条 */
export function contextsOfArticle<T extends CtxLike>(ctxs: readonly T[], article: ArticleRef | null, limit = 3): T[] {
  if (!article) return [];
  const inArticle = (c: T) =>
    article.deleted ? !c.textId || !c.textTitle : c.textId === article.key && !!c.textTitle;
  return ctxs
    .filter(inArticle)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/** 文章下拉框：每篇文章的词数，按最近活跃排序；已删除的文章放最后 */
export function articleOptions(
  words: readonly { article: ArticleRef | null; lastAt: number }[],
): { key: string; title: string; count: number }[] {
  const map = new Map<string, { key: string; title: string; count: number; lastAt: number }>();
  for (const w of words) {
    if (!w.article) continue;
    const cur = map.get(w.article.key);
    if (cur) {
      cur.count += 1;
      cur.lastAt = Math.max(cur.lastAt, w.lastAt);
    } else {
      map.set(w.article.key, { key: w.article.key, title: w.article.title, count: 1, lastAt: w.lastAt });
    }
  }
  return [...map.values()]
    .sort((a, b) => {
      if (a.key === DELETED_ARTICLE) return 1;
      if (b.key === DELETED_ARTICLE) return -1;
      return b.lastAt - a.lastAt;
    })
    .map(({ key, title, count }) => ({ key, title, count }));
}

export const TARGET_LABEL: Record<string, string> = {
  markji: "墨墨",
  anki: "Anki",
  quizlet: "Quizlet",
};

export type ExportBadge = { target: string; app: string; cardTypes: string[] };

/** 把一个词的导出记录汇总成标签：每个应用一枚，列出导出成功的卡片类型 */
export function exportBadges(rows: readonly { target: string; cardType: string; status: string }[]): ExportBadge[] {
  const byTarget = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.status !== "done") continue;
    const set = byTarget.get(r.target) ?? new Set<string>();
    set.add(r.cardType);
    byTarget.set(r.target, set);
  }
  const order = CARD_TYPES.map((t) => t.key as string);
  const labelOf = (k: string) => CARD_TYPES.find((t) => t.key === k)?.label ?? k;
  return [...byTarget.entries()].map(([target, set]) => ({
    target,
    app: TARGET_LABEL[target] ?? target,
    cardTypes: [...set].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(labelOf),
  }));
}

export type Snippet = { before: string; hit: string; after: string };

/**
 * 词表一行里的原句片段：选区前后各留 radius 个字符，被截断的一侧补「…」，生词单独拿出来加粗。
 * 原句里找不到选区（文本被改过）就退回整句开头一段，不加粗。
 */
export function snippetAround(sentence: string, quote: string, radius = 42): Snippet {
  const s = sentence.replace(/\s+/g, " ").trim();
  const at = quote ? s.toLowerCase().indexOf(quote.toLowerCase()) : -1;
  if (at < 0) {
    const cut = s.length > radius * 2 ? s.slice(0, radius * 2).replace(/\s+\S*$/, "") + "…" : s;
    return { before: cut, hit: "", after: "" };
  }
  const end = at + quote.length;
  let before = s.slice(Math.max(0, at - radius), at);
  let after = s.slice(end, end + radius);
  // 不从单词中间切开
  if (at - radius > 0) before = "…" + before.replace(/^\S*\s/, "");
  if (end + radius < s.length) after = after.replace(/\s\S*$/, "") + "…";
  return { before, hit: s.slice(at, end), after };
}

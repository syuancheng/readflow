/**
 * 词典查询的两个纯工具（P41）。没有任何 import，单测直接跑。
 *
 * 1. caseCandidates：没有「大小写不敏感索引」时，用词表自带的唯一索引做精确匹配，
 *    依次试这几种写法，绝不全表扫描。
 *    背景：ECDICT 有 77 万行，`word = ? COLLATE NOCASE` 在没有 NOCASE 索引时是全表扫描，
 *    而 better-sqlite3 是同步的——扫描期间整个 Node 进程处理不了任何请求。
 *    本机实测一次点词（3 条查询）：有索引 < 1ms，没有索引 65～195ms；线上机器更慢。
 * 2. LruCache：词典是只读的，同一个词一次点词在服务端会被查好几遍
 *    （/api/dict、/api/contexts/ensure 里的 lookup、收词时的 lemma……），按词记住结果。
 */

/** 一个词可能的存储写法：原样、全小写、首字母大写、全大写（去重，原样优先） */
export function caseCandidates(word: string): string[] {
  const lower = word.toLowerCase();
  const title = lower.charAt(0).toUpperCase() + lower.slice(1);
  return [...new Set([word, lower, title, word.toUpperCase()])];
}

/** 容量有限的 LRU：读到的条目挪到最新；超过容量丢掉最久没用的 */
export class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

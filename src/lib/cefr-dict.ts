/**
 * CEFR 估算的「服务端适配层」。
 *
 * cefr.ts 是纯函数，只认 RankLookup；这里负责把 ECDICT 接上去、加缓存、
 * 并保证「估算失败不影响导入」。导入一篇文本是核心链路，不能因为词典文件
 * 没装 / 数据库被占用就让整篇文章进不来 —— 难度只是附加信息。
 *
 * 只在服务端调用（读本地 SQLite），不要从客户端组件引用。
 */
import { frequencyRank } from "./dict";
import { estimateCefr, type CefrResult, type RankLookup } from "./cefr";

export function estimateCefrForParts(parts: string[]): CefrResult | null {
  const cache = new Map<string, number | null>();

  // 一篇文章里同一个词会出现几十上百次，按词形缓存能把 SQL 查询数从
  // 「词次数」降到「不同词形数」
  const rankOf: RankLookup = (word) => {
    if (cache.has(word)) return cache.get(word) ?? null;
    let rank: number | null;
    try {
      rank = frequencyRank(word);
    } catch {
      // 词典不存在 / 打不开：整篇估算作废，交给外层返回 null
      throw new Error("ECDICT unavailable");
    }
    cache.set(word, rank);
    return rank;
  };

  try {
    return estimateCefr(parts, rankOf);
  } catch (err) {
    console.warn("[cefr] 难度估算跳过：", (err as Error).message);
    return null;
  }
}

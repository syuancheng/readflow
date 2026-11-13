/**
 * 讲解上下文缓存（P33 spec §7.2，PRD F2）。进程内 LRU，10 分钟过期。
 * 目的：做卡时「接着刚才的讲解对话」出题，messages 前缀逐字一致 → 命中模型缓存。
 * 纯容器：时钟/上限可注入，方便单测（spec §11.1 cards-explain-cache.test.ts）。
 */
/** 与 providers.ts 的 ChatTurn 结构相同；这里自己定义，单测编译本目录时不用拖进 providers 的依赖 */
export type CacheTurn = { role: "system" | "user" | "assistant"; content: string };

export const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟（PRD F2：距离讲解超过 10 分钟不再命中）
export const CACHE_MAX = 500;

export type CacheEntry = {
  userId: string;
  contextId: string;
  messages: CacheTurn[];
  assistantText: string;
  provider: string;
  model: string;
  at: number;
};

type Clock = () => number;

/** 进程内缓存。模块级单例用 createExplainCache()；单测自建实例 */
export class ExplainCache {
  private map = new Map<string, CacheEntry>();
  constructor(
    private readonly ttlMs: number = CACHE_TTL_MS,
    private readonly max: number = CACHE_MAX,
    private readonly clock: Clock = () => Date.now(),
  ) {}

  put(answerId: string, entry: Omit<CacheEntry, "at">): void {
    // 同一个 key 更新时先删再插，不能顺带把别人挤掉
    this.map.delete(answerId);
    if (this.map.size >= this.max) {
      // 淘汰最旧的（Map 保持插入序；get 命中时重插让 LRU 生效）
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(answerId, { ...entry, at: this.clock() });
  }

  /** 命中条件：没过期、用户与记录都匹配（spec §11.1：用户/记录不匹配时不命中） */
  get(answerId: string, userId: string, contextId: string): CacheEntry | null {
    const hit = this.map.get(answerId);
    if (!hit) return null;
    if (this.clock() - hit.at > this.ttlMs) {
      this.map.delete(answerId);
      return null;
    }
    if (hit.userId !== userId || hit.contextId !== contextId) return null;
    // LRU：命中后重插
    this.map.delete(answerId);
    this.map.set(answerId, hit);
    return hit;
  }

  size(): number {
    return this.map.size;
  }
}

let singleton: ExplainCache | null = null;

/** 应用运行时的缓存单例（服务重启清空可接受：只是缓存命中率下降） */
export function explainCache(): ExplainCache {
  if (!singleton) singleton = new ExplainCache();
  return singleton;
}

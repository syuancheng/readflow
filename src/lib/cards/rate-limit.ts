/**
 * 墨墨写请求限速（P33 spec §7.5 / §0.4）。滑动窗口：10 秒最多 20 次、
 * 60 秒最多 40 次，请求之间至少间隔 500ms。上传和建卡都算请求。
 * 纯函数 + 注入时钟，方便单测（spec §11.1 cards-rate-limit.test.ts）。
 */

export const WINDOW_SHORT_MS = 10_000;
export const WINDOW_SHORT_MAX = 20;
export const WINDOW_LONG_MS = 60_000;
export const WINDOW_LONG_MAX = 40;
export const MIN_INTERVAL_MS = 500;

export type RateLimiter = {
  /** 下一次允许请求的时间戳；<= now 表示可以立即请求 */
  nextAt(t: number): number;
  /** 记录一次请求 */
  record(t: number): void;
};

/** 单 token 限速器（墨墨按 token 维度限频，进程内一个实例对应一个 token） */
export function createRateLimiter(
  opts?: Partial<{
    windowShortMs: number;
    windowShortMax: number;
    windowLongMs: number;
    windowLongMax: number;
    minIntervalMs: number;
  }>,
): RateLimiter {
  const cfg = {
    windowShortMs: opts?.windowShortMs ?? WINDOW_SHORT_MS,
    windowShortMax: opts?.windowShortMax ?? WINDOW_SHORT_MAX,
    windowLongMs: opts?.windowLongMs ?? WINDOW_LONG_MS,
    windowLongMax: opts?.windowLongMax ?? WINDOW_LONG_MAX,
    minIntervalMs: opts?.minIntervalMs ?? MIN_INTERVAL_MS,
  };
  const stamps: number[] = [];

  const hitsIn = (from: number, t: number) => stamps.filter((s) => s > t - from).length;

  return {
    nextAt(t: number): number {
      const candidates: number[] = [];
      // 1) 最小间隔
      const last = stamps[stamps.length - 1];
      if (last !== undefined) candidates.push(last + cfg.minIntervalMs);
      // 2) 短窗口
      const shortHits = hitsIn(cfg.windowShortMs, t);
      if (shortHits >= cfg.windowShortMax) {
        const nthFromEnd = stamps[stamps.length - cfg.windowShortMax];
        if (nthFromEnd !== undefined) candidates.push(nthFromEnd + cfg.windowShortMs);
      }
      // 3) 长窗口
      const longHits = hitsIn(cfg.windowLongMs, t);
      if (longHits >= cfg.windowLongMax) {
        const nthFromEnd = stamps[stamps.length - cfg.windowLongMax];
        if (nthFromEnd !== undefined) candidates.push(nthFromEnd + cfg.windowLongMs);
      }
      const wait = candidates.length === 0 ? 0 : Math.max(...candidates) - t;
      return t + Math.max(0, wait);
    },
    record(t: number): void {
      stamps.push(t);
      // 只保留长窗口内的记录
      const cutoff = t - cfg.windowLongMs;
      while (stamps.length > 0 && stamps[0] <= cutoff) stamps.shift();
    },
  };
}

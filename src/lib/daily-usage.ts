/**
 * 每日次数（合并原来的 ai_usage 与 card_usage）。一张表 daily_usage，按 kind 区分：
 * - "ai"：普通账号用站点模型的每日免费讲解次数（lib/ai-quota.ts）
 * - "card"：用站点模型的每日做卡次数（lib/cards/store.ts）
 * 「今天」由调用方算好传进来（都是上海时区的自然日），这里只管读写。
 */
import { sqlite } from "@/db/sqlite";

export type UsageKind = "ai" | "card";

export function usedOn(userId: string, kind: UsageKind, day: string): number {
  const row = sqlite
    .prepare("SELECT count FROM daily_usage WHERE user_id = ? AND day = ? AND kind = ?")
    .get(userId, day, kind) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** 加一次 */
export function addUsage(userId: string, kind: UsageKind, day: string): void {
  sqlite
    .prepare(
      `INSERT INTO daily_usage (user_id, day, kind, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(user_id, day, kind) DO UPDATE SET count = count + 1`,
    )
    .run(userId, day, kind);
}

/** 退一次（失败不计数时用），不会减到负数 */
export function refundUsage(userId: string, kind: UsageKind, day: string): void {
  sqlite
    .prepare("UPDATE daily_usage SET count = MAX(0, count - 1) WHERE user_id = ? AND day = ? AND kind = ?")
    .run(userId, day, kind);
}

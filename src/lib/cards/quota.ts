/**
 * 每天做卡次数（PRD Q1：用站点模型的用户每天最多 30 个词，单独计数；
 * 自带 Key 不限；按上海时区的自然日；失败不计数）。
 * quotaDay 沿用 P28 ai-quota.ts 的写法（spec §13 第 9 条）。
 */
export const CARD_DAILY_LIMIT = 30;

/** 上海时区的自然日（与 ai-quota.quotaDay 同一写法） */
export function cardQuotaDay(now = Date.now()): string {
  return new Date(now).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

export function cardQuotaMessage(): string {
  return "今天做卡的次数用完了（每天 30 个词），明天再来，或者在 设置 → 模型 里填自己的 Key";
}

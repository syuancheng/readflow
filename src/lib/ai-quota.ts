/**
 * 普通账号用站点 AI Key 的每日免费次数（P28）。
 *
 * 只有「普通账号 + 没填自己的 Key」才计数；主账号和自带 Key 的人不受限。
 * 按北京时间的自然日计；上限默认 30 次/天，可用环境变量 READFLOW_AI_DAILY_QUOTA 调整。
 * 查词典不走模型，不占次数。
 */
import { sqlite } from "@/db/sqlite";
import { addUsage, usedOn } from "@/lib/daily-usage";

export function dailyAiQuota(): number {
  const n = Number(process.env.READFLOW_AI_DAILY_QUOTA);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}

export function quotaDay(now = Date.now()): string {
  return new Date(now).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

export function aiUsedToday(userId: string, now = Date.now()): number {
  return usedOn(userId, "ai", quotaDay(now));
}

/** 占用一次；超过上限返回 ok:false，不计数 */
export function consumeAiQuota(userId: string, now = Date.now()): { ok: boolean; used: number; limit: number } {
  const limit = dailyAiQuota();
  const day = quotaDay(now);
  return sqlite.transaction(() => {
    const used = aiUsedToday(userId, now);
    if (used >= limit) return { ok: false, used, limit };
    addUsage(userId, "ai", day);
    return { ok: true, used: used + 1, limit };
  })();
}

export function quotaExceededMessage(limit: number): string {
  return `今天的免费 AI 讲解次数（${limit} 次）用完了，明天会重置。也可以在「设置 → 模型」里填你自己的 API Key，就不受次数限制。`;
}

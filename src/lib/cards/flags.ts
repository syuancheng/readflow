/**
 * 做卡开关（P33 spec §0.5）。纯函数：
 * - 站点设置 cards.enabled（默认 on）、cards.listening（默认 off）
 * - 环境变量 READFLOW_CARDS=off 强制关闭全部
 */

export function cardsEnabled(siteSettings: Record<string, string | undefined>): boolean {
  if (process.env.READFLOW_CARDS === "off") return false;
  return siteSettings["cards.enabled"] !== "off";
}

export function listeningEnabled(siteSettings: Record<string, string | undefined>): boolean {
  if (process.env.READFLOW_CARDS === "off") return false;
  return siteSettings["cards.listening"] === "on";
}

/** 每张卡的字数上限（PRD Q7：普通 1800 / 专业 4000；文档里 4500 是错的） */
export const CHAR_LIMITS = { basic: 1800, pro: 4000 } as const;

export function charLimitFor(membership: string | null | undefined): number {
  return membership === "pro" ? CHAR_LIMITS.pro : CHAR_LIMITS.basic;
}

/**
 * 按账号区分的密钥（P28：邀请码注册之后不止一个人用）。
 *
 * - 主账号（owner）：用站级配置（设置里填的 AI Key / 墨墨 Token，环境变量兜底），和以前一样。
 * - 普通账号：
 *   - 墨墨 Token **只认自己填的**，绝不回退主账号的 —— 否则卡片会推进主账号的墨墨，而且删不掉。
 *   - AI：自己填了 Key 就用自己的、不限次数；没填就用站点的 Key，但每天有免费次数上限，
 *     防止主账号的额度被花光（见 lib/ai-quota.ts）。
 */
import type { AuthUser } from "./auth";
import { resolveMarkjiToken, resolveProvider, SETTINGS_KEYS, type EnvMap, type SettingsMap } from "./config";
import { allSettings, ownSettings } from "./settings-store";

export type AiContext = {
  settings: SettingsMap;
  env: EnvMap;
  /** true = 普通账号在用站点的 Key，要扣每日免费次数 */
  metered: boolean;
};

type Who = Pick<AuthUser, "id" | "isOwner">;

/** 只保留 AI 相关的 key（ai.*），免得把个人资料混进模型解析 */
function aiOnly(settings: SettingsMap): SettingsMap {
  const out: SettingsMap = {};
  for (const [k, v] of Object.entries(settings)) if (k.startsWith("ai.")) out[k] = v;
  return out;
}

/** 普通账号自己有没有配好可用的模型 */
export function hasOwnModel(userId: string): boolean {
  return resolveProvider(aiOnly(ownSettings(userId)), {}) !== null;
}

export function aiContextFor(user: Who): AiContext {
  if (user.isOwner) return { settings: allSettings(), env: process.env, metered: false };
  const own = aiOnly(ownSettings(user.id));
  if (resolveProvider(own, {}) !== null) return { settings: own, env: {}, metered: false };
  return { settings: allSettings(), env: process.env, metered: true };
}

export function markjiTokenFor(user: Who): string | null {
  if (user.isOwner) return resolveMarkjiToken(allSettings(), process.env);
  return ownSettings(user.id)[SETTINGS_KEYS.markjiToken]?.trim() || null;
}

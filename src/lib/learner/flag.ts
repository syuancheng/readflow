/**
 * P32 §0.5 兜底开关（纯函数）。
 * 环境变量优先级最高，用于紧急情况；站长没设过时默认开。
 */
export const PERSONALIZED_ENV = "READFLOW_PERSONALIZED";
export const PERSONALIZED_KEY = "ai.personalized"; // 与 config.ts 的 SETTINGS_KEYS.aiPersonalized 一致

export function isPersonalizedOn(
  settings: Record<string, string | undefined> | null | undefined,
  env: Record<string, string | undefined> | null | undefined,
): boolean {
  if (env?.[PERSONALIZED_ENV] === "off") return false;
  return settings?.[PERSONALIZED_KEY] !== "off";
}

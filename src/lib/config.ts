/**
 * 配置中心：纯逻辑（不碰 DB / Next，可单测）。
 * 负责 provider 元数据、配置键、脱敏、以及「勾选哪个就用哪个」的解析。
 */

export type ProviderId = "deepseek" | "openai" | "claude" | "qwen" | "custom";
export type Protocol = "openai" | "anthropic";

export type ProviderDef = {
  id: ProviderId;
  label: string;
  hint: string;
  baseUrl: string;
  model: string;
  protocol: Protocol;
  /** 兼容旧部署：DB 没配时读哪个环境变量 */
  envKey: string | null;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    hint: "deepseek-chat · OpenAI 兼容",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    protocol: "openai",
    envKey: "DEEPSEEK_API_KEY",
  },
  {
    id: "openai",
    label: "ChatGPT / OpenAI",
    hint: "gpt-4o-mini 等",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    protocol: "openai",
    envKey: "OPENAI_API_KEY",
  },
  {
    id: "claude",
    label: "Claude / Anthropic",
    hint: "原生 Messages API · 流式 SSE",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5-20250929",
    protocol: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "qwen",
    label: "通义千问",
    hint: "DashScope OpenAI 兼容模式",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    protocol: "openai",
    envKey: "DASHSCOPE_API_KEY",
  },
  {
    id: "custom",
    label: "自定义 / 本地模型",
    hint: "任意 OpenAI 兼容端点（如 Ollama）",
    baseUrl: "",
    model: "",
    protocol: "openai",
    envKey: null,
  },
];

export const MASK_PREFIX = "••••";

/**
 * 流式重试协议：服务端重试前吐出该标记，前端收到后清空已渲染文本，
 * 这样「模型中途繁忙/断流」也能完整重试而不会把两段输出拼在一起。
 */
export const STREAM_RESET = "\u0000RF_RESET\u0000";

export const SETTINGS_KEYS = {
  activeProvider: "ai.activeProvider",
  providerKey: (id: string) => `ai.${id}.apiKey`,
  providerModel: (id: string) => `ai.${id}.model`,
  providerBaseUrl: (id: string) => `ai.${id}.baseUrl`,
  markjiToken: "markji.token",
  extensionToken: "extension.token",
  // 个人资料：按账号隔离（profile.* 不回退站级），见 lib/settings-store.ts
  profileName: "profile.displayName",
  profileFullName: "profile.fullName",
  profileBio: "profile.bio",
  profileAvatar: "profile.avatar",
} as const;

export function providerDef(id: string | null | undefined): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** API Key 展示用：只留后四位，返回给浏览器的永远是这个形态 */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return "";
  const s = secret.trim();
  if (s.length <= 8) return MASK_PREFIX;
  return `${MASK_PREFIX}${s.slice(-4)}`;
}

/** 前端把脱敏值原样回传时，服务端必须忽略，不能把掩码写进 DB */
export function isMaskedValue(v: string | null | undefined): boolean {
  return typeof v === "string" && v.startsWith(MASK_PREFIX);
}

export type SettingsMap = Record<string, string>;
export type EnvMap = Record<string, string | undefined>;

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  hint: string;
  protocol: Protocol;
  configured: boolean;
  maskedKey: string;
  model: string;
  baseUrl: string;
  /** key 来自设置页还是环境变量 */
  source: "db" | "env" | "none";
};

export type ResolvedProvider = {
  id: ProviderId;
  label: string;
  protocol: Protocol;
  apiKey: string;
  baseUrl: string;
  model: string;
  source: "db" | "env";
};

function readKey(settings: SettingsMap, env: EnvMap, def: ProviderDef) {
  const fromDb = settings[SETTINGS_KEYS.providerKey(def.id)]?.trim();
  if (fromDb) return { key: fromDb, source: "db" as const };
  const fromEnv = def.envKey ? env[def.envKey]?.trim() : undefined;
  if (fromEnv) return { key: fromEnv, source: "env" as const };
  return { key: "", source: "none" as const };
}

function readEndpoint(settings: SettingsMap, def: ProviderDef) {
  const model = settings[SETTINGS_KEYS.providerModel(def.id)]?.trim() || def.model;
  const baseUrl = settings[SETTINGS_KEYS.providerBaseUrl(def.id)]?.trim() || def.baseUrl;
  return { model, baseUrl };
}

/** 自定义端点必须自己填 baseUrl 和 model，否则不算配好 */
export function isConfigured(settings: SettingsMap, env: EnvMap, def: ProviderDef): boolean {
  const { key } = readKey(settings, env, def);
  if (!key) return false;
  const { model, baseUrl } = readEndpoint(settings, def);
  if (def.id === "custom") return Boolean(model && baseUrl);
  return true;
}

export function providerStatuses(settings: SettingsMap, env: EnvMap): ProviderStatus[] {
  return PROVIDERS.map((def) => {
    const { key, source } = readKey(settings, env, def);
    const { model, baseUrl } = readEndpoint(settings, def);
    return {
      id: def.id,
      label: def.label,
      hint: def.hint,
      protocol: def.protocol,
      configured: isConfigured(settings, env, def),
      maskedKey: maskSecret(key),
      model,
      baseUrl,
      source,
    };
  });
}

/**
 * 解析当前生效的 provider：
 *   1. 显式指定（测试连接时）
 *   2. 用户在设置页勾选的 ai.activeProvider
 *   3. 都没勾：按 PROVIDERS 顺序取第一个已配好 Key 的
 * 勾选优先，未配置则返回 null（调用方给出可读提示，不静默换模型）。
 */
export function resolveProvider(
  settings: SettingsMap,
  env: EnvMap,
  explicitId?: string | null,
): ResolvedProvider | null {
  const configured = PROVIDERS.filter((d) => isConfigured(settings, env, d));
  const chosenId = explicitId || settings[SETTINGS_KEYS.activeProvider] || configured[0]?.id;
  const def = providerDef(chosenId);
  if (!def) return null;

  const { key, source } = readKey(settings, env, def);
  if (!key) return null;
  const { model, baseUrl } = readEndpoint(settings, def);
  if (!model || !baseUrl) return null; // custom 没填全
  if (!isConfigured(settings, env, def)) return null;

  return {
    id: def.id,
    label: def.label,
    protocol: def.protocol,
    apiKey: key,
    baseUrl,
    model,
    source: source === "none" ? "db" : source,
  };
}

/** 墨墨 Token：设置页优先，环境变量兜底（保留旧部署可用） */
export function resolveMarkjiToken(settings: SettingsMap, env: EnvMap): string | null {
  const fromDb = settings[SETTINGS_KEYS.markjiToken]?.trim();
  if (fromDb) return fromDb;
  return env.MARKJI_TOKEN?.trim() || env.MAIMEMO_TOKEN?.trim() || null;
}

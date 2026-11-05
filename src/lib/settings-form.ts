/**
 * 设置表单的纯逻辑（不依赖 DOM / Next，可单测）。
 *
 * 对齐 WorkBuddy「设置 → 模型 → 添加模型」的做法：
 *  - 选好供应商后自动带出接口地址与默认模型名，用户通常只需要补 API Key
 *  - API Key / 接口地址 / 模型名称各自给一条可读的内联错误，而不是笼统的「保存失败」
 *  - 配置不完整的模型不能保存，也不会被选为当前使用
 *  - 左侧导航可搜索、模型名可下拉选也可自定义
 */
import { PROVIDERS, type ProviderId } from "./config";

export type FormValues = {
  apiKey: string;
  endpoint: string;
  model: string;
};

export type FormErrors = Partial<Record<keyof FormValues, string>>;

/** 全角字符 / 全角空格：从网页复制 Key 时最常见的脏字符 */
const FULLWIDTH = /[\u3000\uFF00-\uFFEF]/;

/** 统一掉末尾斜杠，避免 https://api.x.com/v1/ 这类写法 */
export function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function checkApiKey(raw: string, optional = false): string | null {
  const v = raw.trim();
  if (!v) return optional ? null : "请输入 API Key";
  if (/\s/.test(v) || FULLWIDTH.test(v)) {
    return "API Key 格式不正确，请去掉空格、换行和全角字符";
  }
  if (v.length < 8) return "API Key 看起来太短，请检查是否复制完整";
  return null;
}

export function checkEndpoint(raw: string): string | null {
  const v = normalizeEndpoint(raw);
  if (!v) return "请输入接口地址";
  // OpenAI SDK 自己会补 /chat/completions，这里要的是基地址
  if (/\/chat\/completions$/i.test(v)) {
    return "请填写接口基地址，末尾不要带 /chat/completions";
  }
  if (!/^https?:\/\//i.test(v)) return "接口地址必须以 http:// 或 https:// 开头";
  try {
    new URL(v);
  } catch {
    return "接口地址格式不正确";
  }
  return null;
}

export function checkModel(raw: string): string | null {
  return raw.trim() ? null : "请输入模型名称";
}

/** 选提供商 → 自动填充接口地址与默认模型名 */
export function presetFor(id: ProviderId): { endpoint: string; model: string } {
  const def = PROVIDERS.find((p) => p.id === id);
  return { endpoint: def?.baseUrl ?? "", model: def?.model ?? "" };
}

/**
 * editing=true 时 API Key 留空表示「不修改已保存的 Key」。
 */
export function validateForm(values: FormValues, opts: { editing: boolean }): FormErrors {
  const errors: FormErrors = {};
  const keyErr = checkApiKey(values.apiKey, opts.editing);
  if (keyErr) errors.apiKey = keyErr;
  const endpointErr = checkEndpoint(values.endpoint);
  if (endpointErr) errors.endpoint = endpointErr;
  const modelErr = checkModel(values.model);
  if (modelErr) errors.model = modelErr;
  return errors;
}

/* ------------------------------------------------------------------ *
 * 设置页导航（WorkBuddy 风格：搜索框 + 分组）
 * ------------------------------------------------------------------ */

export type NavId = "models" | "markji" | "extension" | "storage";
export type NavItem = { id: NavId; title: string; keywords: string[] };
export type NavGroup = { title: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "设置",
    items: [
      { id: "models", title: "模型", keywords: ["模型", "model", "api key", "ai", "大模型"] },
      { id: "markji", title: "墨墨记单词", keywords: ["墨墨", "markji", "token", "记忆卡"] },
    ],
  },
  {
    title: "功能",
    items: [
      { id: "extension", title: "浏览器插件", keywords: ["插件", "extension", "chrome", "同步"] },
    ],
  },
  {
    title: "数据与安全",
    items: [
      { id: "storage", title: "本机数据", keywords: ["安全", "存储", "sqlite", "隐私", "备份"] },
    ],
  },
];

/** 空查询返回全部分组；命中标题或关键字才保留，空分组剔除 */
export function filterNavGroups(query: string, groups: NavGroup[] = NAV_GROUPS): NavGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({
      title: g.title,
      items: g.items.filter(
        (it) =>
          it.title.toLowerCase().includes(q) ||
          it.keywords.some((k) => k.toLowerCase().includes(q)),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

/* ------------------------------------------------------------------ *
 * 添加模型弹窗：供应商下拉 / 文档 / 模型名候选
 * ------------------------------------------------------------------ */

/** 供应商下拉展示名（比内部 label 更贴近控制台里的叫法） */
export const PROVIDER_SELECT_LABEL: Record<ProviderId, string> = {
  deepseek: "DeepSeek / 深度求索",
  openai: "ChatGPT / OpenAI",
  claude: "Claude / Anthropic",
  qwen: "通义千问 / 阿里云百炼",
  custom: "自定义 / OpenAI 兼容端点",
};

/** 「查看文档」跳到各服务商申请 API Key 的页面 */
export const PROVIDER_DOCS: Record<ProviderId, string> = {
  deepseek: "https://platform.deepseek.com/api_keys",
  openai: "https://platform.openai.com/api-keys",
  claude: "https://console.anthropic.com/settings/keys",
  qwen: "https://help.aliyun.com/zh/model-studio/get-api-key",
  custom: "https://platform.openai.com/docs/api-reference/chat",
};

export function docsUrlFor(id: ProviderId): string {
  return PROVIDER_DOCS[id];
}

/** 各供应商常用 model ID；第一项永远是预设默认值 */
const MODEL_PRESETS: Record<ProviderId, string[]> = {
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  claude: ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"],
  qwen: ["qwen-plus", "qwen-turbo", "qwen-max"],
  custom: ["qwen3:8b", "qwen2.5-coder:7b", "llama3.1:8b"],
};

export function modelOptionsFor(id: ProviderId): string[] {
  const preset = presetFor(id).model;
  const rest = (MODEL_PRESETS[id] ?? []).filter((m) => m !== preset);
  return preset ? [preset, ...rest] : rest;
}

/** 判断当前 model 是否属于候选（否则下拉要显示「自定义模型名」） */
export function isPresetModel(id: ProviderId, model: string): boolean {
  return modelOptionsFor(id).includes(model.trim());
}

export const CUSTOM_MODEL_OPTION = "__custom_model__";

/** 下拉选中某一项后，算出真正写进表单的 model 值 */
export function applyModelOption(option: string, customModel: string, current: string): string {
  if (option === CUSTOM_MODEL_OPTION) return customModel.trim();
  return option.trim() || current;
}

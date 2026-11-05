/**
 * 设置表单的纯校验逻辑（不依赖 DOM / Next，可单测）。
 *
 * 对齐 WorkBuddy「设置 → 模型 → 添加模型」的做法：
 *  - 选好提供商后自动带出接口地址与默认模型名，用户通常只需要补 API Key
 *  - API Key / 接口地址 / 模型名称各自给一条可读的内联错误，而不是笼统的「保存失败」
 *  - 配置不完整的模型不能保存，也不会被选为当前使用
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

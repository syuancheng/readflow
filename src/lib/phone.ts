/**
 * 手机号规则（P21）。纯函数、零依赖：服务端校验与客户端展示共用。
 */
export type PhoneRule = { ok: boolean; reason?: string };

/**
 * 手机号归一化：去掉空格 / 短横线 / 括号和 +86、0086、86 前缀，只保留中国大陆
 * 11 位手机号（1 开头、第二位 3–9）。不合法返回 null。
 * 落库与登录比对都用归一化后的值，「138 0013 8000」和「+86 13800138000」是同一个号。
 *
 * 只校验格式，不发验证码：本地服务不接短信网关（按条收费），所以号码不代表「已验证」，
 * 只是一个好记的登录名。
 */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.replace(/[\s\-()（）]/g, "");
  s = s.replace(/^(\+86|0086)/, "");
  if (/^86\d{11}$/.test(s)) s = s.slice(2);
  return /^1[3-9]\d{9}$/.test(s) ? s : null;
}

export function checkPhone(v: unknown): PhoneRule {
  if (typeof v !== "string" || !v.trim()) return { ok: false, reason: "请填写手机号" };
  if (!normalizePhone(v)) return { ok: false, reason: "手机号格式不正确（中国大陆 11 位）" };
  return { ok: true };
}

/** 展示用脱敏：138****8000 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;
}


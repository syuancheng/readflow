/**
 * 常用问题的校验规则（P44）。纯函数，前后端和单测共用，只用相对路径 import。
 * 用户在输入框左边的「＋」菜单里加自己的常用问题，点一下就发给 AI（和手打一样）。
 */

export const MAX_QUICK_QUESTIONS = 20;
export const MAX_QUICK_QUESTION_CHARS = 100;

/** 清理用户输入：只收字符串，换行 / 连续空白压成一个空格，去首尾空白；空的或超长返回 null */
export function normalizeQuestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || [...text].length > MAX_QUICK_QUESTION_CHARS) return null;
  return text;
}

export type AddCheck = { ok: true; text: string } | { ok: false; reason: string };

/** 能不能加：格式合法、没有重复（不分大小写）、没超过上限 */
export function checkAdd(existing: readonly string[], raw: unknown): AddCheck {
  const text = normalizeQuestion(raw);
  if (!text) {
    return { ok: false, reason: `问题要写 1～${MAX_QUICK_QUESTION_CHARS} 个字` };
  }
  if (existing.length >= MAX_QUICK_QUESTIONS) {
    return { ok: false, reason: `最多存 ${MAX_QUICK_QUESTIONS} 个常用问题，先删掉不用的` };
  }
  const key = text.toLowerCase();
  if (existing.some((e) => e.toLowerCase() === key)) {
    return { ok: false, reason: "这个问题已经在常用问题里了" };
  }
  return { ok: true, text };
}

/**
 * P32 F5：「太浅 / 刚好 / 太深」反馈的共用逻辑。
 * 路由文件只能导出 HTTP 方法，所以放这里；网站与插件各用自己的鉴权。
 */
import { setFeedback } from "./learner-store";
import type { Feedback } from "./learner/types";

export const FEEDBACK_RATINGS: readonly Feedback[] = ["shallow", "right", "deep"];

export function submitFeedback(
  userId: string,
  body: unknown,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "请求格式错误" };
  }
  const o = body as Record<string, unknown>;
  const answerId = typeof o.answerId === "string" ? o.answerId.trim().slice(0, 120) : "";
  const rating = o.rating;
  if (!answerId || typeof rating !== "string" || !(FEEDBACK_RATINGS as readonly string[]).includes(rating)) {
    return { ok: false, status: 400, error: "反馈取值不对" };
  }
  // 事件不存在 / 不属于当前用户 / 不是一段讲解，一律 404，不透露数据是否存在
  if (!setFeedback(userId, answerId, rating as Feedback)) {
    return { ok: false, status: 404, error: "找不到这段讲解" };
  }
  return { ok: true };
}

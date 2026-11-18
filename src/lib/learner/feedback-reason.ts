/**
 * 反馈原因：三档评价之外，学生可以标「为什么」。
 * 原因只作为信号写进档案/夜间整理，不参与三档计数（反馈次数仍按 feedback 算）。
 * 纯函数，只能相对路径 import。
 */
export const FEEDBACK_REASONS = ["gave_answer", "too_much", "missed_point", "unnecessary"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export const FEEDBACK_REASON_LABEL: Record<FeedbackReason, string> = {
  gave_answer: "直接给了答案或整句翻译",
  too_much: "讲得太多太细",
  missed_point: "没讲到我卡住的地方",
  unnecessary: "这段不需要讲",
};

export function normalizeFeedbackReason(value: unknown): FeedbackReason | null {
  if (typeof value !== "string") return null;
  return (FEEDBACK_REASONS as readonly string[]).includes(value) ? (value as FeedbackReason) : null;
}

/** 一行里的中文说明，例如「原因：直接给了答案或整句翻译」；未知原因不输出 */
export function formatReasonLine(reason: string | null | undefined): string {
  const r = normalizeFeedbackReason(reason);
  return r ? `原因：${FEEDBACK_REASON_LABEL[r]}` : "";
}

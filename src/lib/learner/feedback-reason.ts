/**
 * 反馈原因：三档评价之外，学生可以标「为什么」。
 * 原因只作为信号写进档案/夜间整理，不参与三档计数（反馈次数仍按 feedback 算）。
 *
 * 2026-11-18 改造：
 * - 原因按档位分组（太浅 = 讲得不够，太深 = 讲得过头），「刚好」是正向反馈不追问原因。
 * - 预设选项存 code（可统计、可翻译成中文）；学生也可以写自己的原因（自由文本）。
 *   自由文本必须能一路走到学生档案和夜间整理，否则自定义就是摆设。
 * - 两套函数职责分开：normalize 用于写库校验，format 用于读取展示，互不混淆。
 *
 * 纯函数，只能相对路径 import（单测把本目录编译成 CommonJS 直接跑）。
 */
import type { Feedback } from "./types";

/** 全部预设 code（含新旧），用于「这是不是预设」的判断 */
export const FEEDBACK_REASONS = [
  "gave_answer", "too_much", "unnecessary",
  "missed_point", "literal_only", "still_confused", "covered_known", "no_thinking",
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export const FEEDBACK_REASON_LABEL: Record<FeedbackReason, string> = {
  // 太深：讲得过头
  gave_answer: "直接给了答案或整句翻译",
  too_much: "讲得太多太细",
  unnecessary: "这段不需要讲",
  no_thinking: "全分析了，没留给我自己想",
  // 太浅：讲得不够
  missed_point: "没讲到我卡住的地方",
  literal_only: "只给了字面意思",
  still_confused: "看完还是没懂",
  covered_known: "讲了我已经懂的",
};

/** 自由文本原因的上限：防止长篇文字把学生档案撑爆 */
export const CUSTOM_REASON_MAX_CHARS = 40;

/**
 * 预设选项按档位分组。「刚好」是正向反馈，返回空数组——UI 据此不渲染原因行。
 * 切档时不属于新档位的旧 preset 会被清掉；自由文本保留（除非切到「刚好」）。
 */
export const REASON_OPTIONS_BY_FEEDBACK: Record<Feedback, readonly FeedbackReason[]> = {
  shallow: ["missed_point", "literal_only", "still_confused", "covered_known"],
  right: [],
  deep: ["gave_answer", "too_much", "unnecessary", "no_thinking"],
};

/** 该档位是否追问原因；「刚好」返回空 */
export function reasonsForFeedback(feedback: Feedback | null | undefined): readonly FeedbackReason[] {
  if (!feedback) return [];
  return REASON_OPTIONS_BY_FEEDBACK[feedback] ?? [];
}

function normalizePresetReason(value: unknown): FeedbackReason | null {
  if (typeof value !== "string") return null;
  return (FEEDBACK_REASONS as readonly string[]).includes(value) ? (value as FeedbackReason) : null;
}

/**
 * 切档后要保留的原因：
 * - 切到「刚好」→ 一律清空（正向反馈不该带原因，否则档案里会出现自相矛盾的记录）；
 * - 旧原因是预设但不属于新档位 → 清空；
 * - 自由文本 → 保留，它是学生自己的话，不替他决定扔掉。
 */
export function reasonForFeedback(reason: string | null | undefined, feedback: Feedback): string | null {
  if (!reason) return null;
  if (reasonsForFeedback(feedback).length === 0) return null;
  const preset = normalizePresetReason(reason);
  if (preset && !reasonsForFeedback(feedback).includes(preset)) return null;
  return reason;
}

/**
 * 写库校验：预设 code 原样保留；其他字符串当作学生自定义的自由文本。
 * 自由文本去掉换行与首尾空白，截到上限；空串返回 null。
 * 未知字符串不会丢，按自由文本原样留着——以后加新预设时旧客户端发来的值也不至于消失。
 */
export function normalizeFeedbackReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const preset = normalizePresetReason(value);
  if (preset) return preset;
  const text = value.replace(/[\r\n]+/g, " ").trim().slice(0, CUSTOM_REASON_MAX_CHARS);
  return text || null;
}

/** 一行里的中文说明：预设 code 翻译成中文，自定义原因原样输出 */
export function formatReasonLine(reason: string | null | undefined): string {
  if (!reason) return "";
  const preset = normalizePresetReason(reason);
  const label = preset ? FEEDBACK_REASON_LABEL[preset] : reason.trim();
  return label ? `原因：${label}` : "";
}

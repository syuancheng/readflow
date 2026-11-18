"use client";

/**
 * 讲解下方的「这次讲得：太浅 · 刚好 · 太深」（P32 F5，P34 抽成组件）。
 * 讲解当时与回看共用同一个组件、同一套样式（src/styles/p34-feedback.css）。
 * 两种状态：未评价（三个都可点）/ 已评价（选中项绿色 + ✓，另两个仍可点、随时可改）。
 * 2026-11-18：已评价时可再点一行原因标签，原因随同一条反馈写回数据库。
 */
import { FEEDBACK_REASON_LABEL, FEEDBACK_REASONS, type FeedbackReason } from "@/lib/learner/feedback-reason";
import type { Feedback } from "@/lib/learner/types";

const OPTIONS: { value: Feedback; label: string }[] = [
  { value: "shallow", label: "太浅" },
  { value: "right", label: "刚好" },
  { value: "deep", label: "太深" },
];

export default function FeedbackRow({
  value,
  error,
  reason,
  onRate,
  onReason,
}: {
  value: Feedback | null | undefined;
  /** 保存失败的原因（放在 title 里，与原来一致） */
  error?: string;
  /** 当前原因（已选评价才显示） */
  reason?: string | null;
  onRate: (rating: Feedback) => void;
  /** 选/改原因；传 null 表示清除 */
  onReason?: (reason: FeedbackReason | null) => void;
}) {
  return (
    <div className="rf-feedback-row" title={error}>
      <span>这次讲得：</span>
      {OPTIONS.map((o, j) => (
        <span key={o.value}>
          {j > 0 && <span aria-hidden> · </span>}
          <button
            type="button"
            className={`rf-feedback-btn ${value === o.value ? "rf-feedback-on" : ""}`}
            data-rating={o.value}
            aria-pressed={value === o.value}
            title={error || undefined}
            onClick={() => onRate(o.value)}
          >
            {value === o.value && (
              <span className="rf-feedback-check" aria-hidden>
                ✓
              </span>
            )}
            {o.label}
          </button>
        </span>
      ))}
      {value && onReason && (
        <span className="rf-feedback-reasons">
          <span aria-hidden> · </span>
          <span>原因：</span>
          {FEEDBACK_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              className={`rf-feedback-btn rf-feedback-reason ${reason === r ? "rf-feedback-on" : ""}`}
              data-reason={r}
              aria-pressed={reason === r}
              title={FEEDBACK_REASON_LABEL[r]}
              onClick={() => onReason(reason === r ? null : r)}
            >
              {FEEDBACK_REASON_LABEL[r]}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

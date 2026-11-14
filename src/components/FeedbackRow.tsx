"use client";

/**
 * 讲解下方的「这次讲得：太浅 · 刚好 · 太深」（P32 F5，P34 抽成组件）。
 * 讲解当时与回看共用同一个组件、同一套样式（src/styles/p34-feedback.css）。
 * 两种状态：未评价（三个都可点）/ 已评价（选中项绿色 + ✓，另两个仍可点、随时可改）。
 */
import type { Feedback } from "@/lib/learner/types";

const OPTIONS: { value: Feedback; label: string }[] = [
  { value: "shallow", label: "太浅" },
  { value: "right", label: "刚好" },
  { value: "deep", label: "太深" },
];

export default function FeedbackRow({
  value,
  error,
  onRate,
}: {
  value: Feedback | null | undefined;
  /** 保存失败的原因（放在 title 里，与原来一致） */
  error?: string;
  onRate: (rating: Feedback) => void;
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
    </div>
  );
}

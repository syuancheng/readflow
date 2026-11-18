"use client";

/**
 * 讲解下方的「这次讲得：太浅 · 刚好 · 太深」（P32 F5，P34 抽成组件）。
 * 讲解当时与回看共用同一个组件、同一套样式（src/styles/p34-feedback.css）。
 * 两种状态：未评价（三个都可点）/ 已评价（选中项绿色 + ✓，另两个仍可点、随时可改）。
 *
 * 2026-11-18：原因按档位分组——「刚好」不渲染原因行；太浅/太深各渲自己的选项；
 * 末尾「其他…」点开内联输入框，学生可写自己的原因（40 字内）。
 */
import {
  CUSTOM_REASON_MAX_CHARS,
  FEEDBACK_REASON_LABEL,
  reasonsForFeedback,
  type FeedbackReason,
} from "@/lib/learner/feedback-reason";
import type { Feedback } from "@/lib/learner/types";
import { useState } from "react";

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
  /** 当前原因（已选评价才显示；预设 code 或自由文本） */
  reason?: string | null;
  onRate: (rating: Feedback) => void;
  /** 选/改原因；传 null 表示清除。预设 code 或自定义文本均可 */
  onReason?: (reason: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const options = reasonsForFeedback(value);
  const showReasons = Boolean(value && onReason && options.length > 0);
  // TS 不会把 Boolean(...) 窄化成 onReason 非空；下面两处点击都先接住它
  const changeReason = onReason ?? (() => {});

  function submitCustom() {
    const text = draft.trim();
    setEditing(false);
    setDraft("");
    if (text) onReason?.(text);
  }

  // 当前原因是不是预设之一；不是就是自由文本（回看时要能显示出来）
  const isPreset = options.includes(reason as FeedbackReason);

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
            onClick={() => {
              setEditing(false);
              setDraft("");
              onRate(o.value);
            }}
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
      {showReasons && (
        <span className="rf-feedback-reasons">
          <span aria-hidden> · </span>
          <span>原因：</span>
          {options.map((r) => (
            <button
              key={r}
              type="button"
              className={`rf-feedback-btn rf-feedback-reason ${reason === r ? "rf-feedback-on" : ""}`}
              data-reason={r}
              aria-pressed={reason === r}
              title={FEEDBACK_REASON_LABEL[r]}
              onClick={() => {
                setEditing(false);
                changeReason(reason === r ? null : r);
              }}
            >
              {FEEDBACK_REASON_LABEL[r]}
            </button>
          ))}
          {/* 已有的自定义原因显示为可清除的标签，回看时能认出来 */}
          {reason && !isPreset && (
            <button
              type="button"
              className="rf-feedback-btn rf-feedback-reason rf-feedback-on"
              data-reason="custom"
              title="点击清除这条自定义原因"
              onClick={() => {
                setEditing(false);
                changeReason(null);
              }}
            >
              {reason} ×
            </button>
          )}
          {!editing ? (
            <button
              type="button"
              className="rf-feedback-btn rf-feedback-custom-open"
              data-reason="custom-open"
              onClick={() => setEditing(true)}
            >
              其他…
            </button>
          ) : (
            <span className="rf-feedback-custom">
              <input
                aria-label="自己写原因"
                value={draft}
                maxLength={CUSTOM_REASON_MAX_CHARS}
                autoFocus
                placeholder={`自己写（${CUSTOM_REASON_MAX_CHARS} 字内）`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCustom();
                  if (e.key === "Escape") {
                    setEditing(false);
                    setDraft("");
                  }
                }}
              />
              <button type="button" className="rf-feedback-btn" onClick={submitCustom}>
                好
              </button>
            </span>
          )}
        </span>
      )}
    </div>
  );
}

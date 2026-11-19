"use client";

import { useEffect, useRef } from "react";

/**
 * 在 AI 回答里划选文字后浮出的工具条，只有一个「提问」按钮（参考 WorkBuddy 的选区浮层）。
 * 只负责展示与定位，选中文本已由 ChatTurn 在 mouseup 时存下来（否则点按钮会让选区消失）。
 * 用 position: fixed + 视口坐标，天然跟着滚动；点外部或 Esc 收起。
 */
export type SelectionAsk = { text: string; top: number; left: number; below: boolean };

export default function SelectionAskBar({
  selection,
  onAsk,
  onDismiss,
}: {
  selection: SelectionAsk | null;
  onAsk: (text: string) => void;
  onDismiss: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selection) return;
    const onDown = (e: MouseEvent) => {
      if (bar.current && bar.current.contains(e.target as Node)) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    // 延后一帧再挂，避免触发浮层那次 mouseup 的后续 click 立刻把它关掉
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [selection, onDismiss]);

  if (!selection) return null;
  return (
    <div
      ref={bar}
      className="rf-selection-ask"
      role="toolbar"
      aria-label="对选中内容提问"
      style={{
        position: "fixed",
        top: selection.top,
        left: selection.left,
        transform: selection.below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        gap: "4px",
        padding: "4px",
        background: "var(--rf-bg-surface)",
        border: "var(--rf-border-width) solid var(--rf-border)",
        borderRadius: "10px",
        boxShadow: "0 6px 20px rgba(0,0,0,.12)",
      }}
    >
      <button
        type="button"
        className="rf-selection-ask-btn"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "6px 12px",
          border: 0,
          borderRadius: "7px",
          background: "var(--rf-accent)",
          color: "var(--rf-bg-surface)",
          fontSize: "var(--rf-text-sm)",
          fontWeight: 500,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onAsk(selection.text)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        提问
      </button>
    </div>
  );
}

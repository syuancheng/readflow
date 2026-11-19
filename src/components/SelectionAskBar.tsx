"use client";

import { useEffect, useRef } from "react";

/**
 * 划选 AI 回答后浮出的工具条：白底、细边框、一个带细线图标的文字按钮。
 * 形态完全对齐右栏现有的「常用问题」菜单（.rf-menu）：同样的背景、边框、圆角、
 * 字号与 hover，避免引入一套抢眼的实心色块。
 * 选中的文本由 ChatTurn 在 mouseup 时存下来（点按钮会让原生选区消失）。
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
        // 浮层贴选区起点，是它的附属物，不做居中大弹窗（A-03 对齐）
        transform: selection.below ? "translateY(0)" : "translateY(-100%)",
        zIndex: 60,
      }}
    >
      <button
        type="button"
        className="rf-selection-ask-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onAsk(selection.text)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        添加到对话
      </button>
    </div>
  );
}

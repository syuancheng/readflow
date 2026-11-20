"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_REPLIES, REPLY_NOTE_MAX_CHARS } from "@/lib/ai-thread";

/**
 * 划选 AI 回答后浮出的「回复」（P58，参照 Claude Code 的 Reply）：
 * 先是一个按钮；点开后原地变成一个单行输入，写下针对这段话想说什么（可不写），回车就把
 * 「引用 + 批注」加进底部输入框。白底、细边框，形态对齐右栏「常用问题」菜单（.rf-menu）。
 * 选中的文本由 ChatTurn 在 mouseup 时存下来（点按钮会让原生选区消失）。
 */
export type SelectionAsk = { text: string; top: number; left: number; below: boolean };

/** 展开后输入框的宽度（px）：窄右栏里也放得下，且用视口边界约束，不超出窗口 */
const INPUT_WIDTH = 320;

export default function SelectionAskBar({
  selection,
  full,
  onAsk,
  onDismiss,
}: {
  selection: SelectionAsk | null;
  /** 已经加满 MAX_REPLIES 条：按钮禁用 */
  full: boolean;
  onAsk: (text: string, note: string) => void;
  onDismiss: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  // 用 ref 拿最新的 onDismiss：上层每次渲染都会传新函数，不能让它触发监听反复卸载再挂上
  // （卸载到重新挂上之间的空档里按 Esc，就会漏到阅读页「Esc 关右栏」）
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const active = selection !== null;

  // 换了一段选区：回到按钮形态，清掉上一次没写完的批注
  useEffect(() => {
    setEditing(false);
    setNote("");
  }, [selection?.text, selection?.top, selection?.left]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (bar.current && bar.current.contains(e.target as Node)) return;
      dismissRef.current();
    };
    // 捕获阶段先拿到 Esc：只关这个浮层，不让阅读页「Esc 关右栏」的监听接着把整个右栏也关了
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        dismissRef.current();
      }
    };
    // Esc 的监听立刻挂上（不能留空档）；点外面关闭的监听延后一帧，避免触发浮层那次 mouseup 的后续 click 立刻把它关掉
    document.addEventListener("keydown", onKey, true);
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [active]);

  if (!selection) return null;

  // 展开后更宽：左边缘贴选区起点，但不超出视口右界
  const left = editing
    ? Math.max(8, Math.min(selection.left, window.innerWidth - INPUT_WIDTH - 24))
    : selection.left;

  function submit() {
    if (!selection || full) return;
    onAsk(selection.text, note.trim());
  }

  return (
    <div
      ref={bar}
      className={`rf-selection-ask${editing ? " rf-selection-ask-editing" : ""}`}
      role="toolbar"
      aria-label="回复选中的内容"
      style={{
        position: "fixed",
        top: selection.top,
        left,
        // 浮层贴选区起点，是它的附属物，不做居中大弹窗（A-03 对齐）
        transform: selection.below ? "translateY(0)" : "translateY(-100%)",
        zIndex: 60,
      }}
    >
      {editing ? (
        <div className="rf-selection-ask-card" style={{ width: INPUT_WIDTH }}>
          {/* 被回复的那段原话：左竖线 + 灰字单行（Claude Code 的 Reply 同款，也和对话气泡里的引用一致） */}
          <div className="rf-selection-ask-quote" title={selection.text}>{selection.text}</div>
          <div className="rf-selection-ask-field">
          <input
            ref={input}
            className="rf-selection-ask-input"
            aria-label="对这段话的批注"
            placeholder="回复这段话"
            maxLength={REPLY_NOTE_MAX_CHARS}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                // 阅读页「Esc 关右栏」的监听也挂在 document 上，要 stopImmediatePropagation 才拦得住
                e.nativeEvent.stopImmediatePropagation();
                e.stopPropagation();
                onDismiss();
              }
            }}
          />
          {/* 只留一个回车标志：点它或按回车都是加入（Claude Code 的 Reply 同款） */}
          <button type="button" className="rf-selection-ask-enter" aria-label="加入回复" title="加入回复（回车）" onMouseDown={(e) => e.preventDefault()} onClick={submit}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 5v6a3 3 0 0 1-3 3H5" />
              <path d="M9 10l-4 4 4 4" />
            </svg>
          </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="rf-selection-ask-btn"
          disabled={full}
          title={full ? `最多 ${MAX_REPLIES} 条回复` : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setEditing(true)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 14L4 9l5-5" />
            <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
          回复
        </button>
      )}
    </div>
  );
}

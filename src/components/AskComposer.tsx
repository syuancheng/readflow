"use client";

import { useEffect, useRef, useState } from "react";
import type { AskPreset, AskReq } from "@/lib/ask-presets";

/**
 * 右栏底部的对话输入区（P44）：唯一的 AI 入口。
 * 上方一排快捷问题（输入框为空时显示，点一下就发送），下面是输入框，发送图标在框内右下角。
 * 「做成卡片」和「整句没看懂」同级：都是给 AI 发一条消息。
 */
export default function AskComposer({
  presets,
  busy,
  card,
  cardTitle,
  onAsk,
  onMakeCard,
}: {
  presets: AskPreset[];
  /** AI 正在回答：快捷项和发送暂停，输入框仍可输入 */
  busy: boolean;
  /** 「做成卡片」快捷项的状态 */
  card: "hidden" | "enabled" | "disabled";
  /** 置灰时的提示（例如「正在保存这条记录…」） */
  cardTitle?: string;
  onAsk: (req: AskReq) => void;
  onMakeCard: () => void;
}) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  // 随内容增高，上限 160px，超过内部滚动
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  function send() {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    onAsk({ ask: q, prompt: q, askKind: "custom" });
    box.current?.focus();
  }

  return (
    <div className="rf-composer">
      {text === "" && (presets.length > 0 || card !== "hidden") && (
        <div className="rf-quick" role="group" aria-label="常用问题">
          {presets.map((p) => (
            <button key={p.key} type="button" className="rf-quick-chip" disabled={busy} onClick={() => onAsk(p.req)}>
              {p.label}
            </button>
          ))}
          {card !== "hidden" && (
            <button
              type="button"
              className="rf-quick-chip"
              disabled={card === "disabled" || busy}
              title={cardTitle}
              onClick={onMakeCard}
            >
              做成卡片
            </button>
          )}
        </div>
      )}
      <div className="rf-composer-box">
        <textarea
          ref={box}
          className="rf-composer-input"
          aria-label="向 AI 提问"
          placeholder="我有别的问题…"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送，Shift+Enter 换行——多行输入的标准约定
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="rf-composer-send"
          disabled={!text.trim() || busy}
          onClick={send}
          aria-label="发送问题"
          title="发送"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 3 10.5 13.5" />
            <path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

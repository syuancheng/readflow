"use client";

import { useEffect, useRef, useState } from "react";
import type { AskPreset, AskReq } from "@/lib/ask-presets";
import { MAX_QUICK_QUESTION_CHARS } from "@/lib/quick-questions";
import { useQuickQuestions } from "@/lib/use-quick-questions";

/**
 * 右栏底部的对话输入区（P44）：唯一的 AI 入口，版式参照 Gemini / ChatGPT 的输入框。
 * 一个圆角容器：左边「＋」、中间输入框、右边发送（有文字才出现）。
 * 「＋」展开常用问题菜单：上面是随选区变化的内置问题和「做成卡片」，下面是用户自己加的常用问题（可添加、可删除）。
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
  /** AI 正在回答：菜单里的问题和发送暂停，输入框仍可输入 */
  busy: boolean;
  /** 「做成卡片」菜单项的状态 */
  card: "hidden" | "enabled" | "disabled";
  /** 置灰时的提示（例如「正在保存这条记录…」） */
  cardTitle?: string;
  onAsk: (req: AskReq) => void;
  onMakeCard: () => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const quick = useQuickQuestions();

  // 随内容增高，上限 160px，超过内部滚动
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // 菜单：点到外面或按 Esc 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function closeMenu(focusPlus = false) {
    setOpen(false);
    setDraft("");
    setAddError("");
    if (focusPlus) plus.current?.focus();
  }

  function toggleMenu() {
    if (open) return closeMenu();
    setOpen(true);
    void quick.load();
  }

  function pick(run: () => void) {
    closeMenu();
    run();
  }

  function send() {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    onAsk({ ask: q, prompt: q, askKind: "custom" });
    box.current?.focus();
  }

  async function saveDraft() {
    const err = await quick.add(draft);
    if (err) return setAddError(err);
    setDraft("");
    setAddError("");
  }

  return (
    <div
      className="rf-composer"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          // Next 的 React 根就是 document，阅读页「Esc 关右栏」的监听也挂在 document 上：
          // 光 stopPropagation 拦不住同一个节点上的其它监听，要 stopImmediatePropagation
          e.nativeEvent.stopImmediatePropagation();
          e.stopPropagation();
          closeMenu(true);
        }
      }}
    >
      {open && (
        <div className="rf-menu" role="menu" aria-label="常用问题">
          <div className="rf-menu-group">
            {presets.map((p) => (
              <button key={p.key} type="button" role="menuitem" className="rf-menu-item" disabled={busy} onClick={() => pick(() => onAsk(p.req))}>
                {p.label}
              </button>
            ))}
            {card !== "hidden" && (
              <button
                type="button"
                role="menuitem"
                className="rf-menu-item"
                disabled={card === "disabled" || busy}
                title={cardTitle}
                onClick={() => pick(onMakeCard)}
              >
                做成卡片
              </button>
            )}
          </div>
          <div className="rf-menu-group">
            {quick.items.map((q) => (
              <div className="rf-menu-row" key={q.id}>
                <button
                  type="button"
                  role="menuitem"
                  className="rf-menu-item"
                  disabled={busy}
                  onClick={() => pick(() => onAsk({ ask: q.text, prompt: q.text, askKind: "custom" }))}
                >
                  {q.text}
                </button>
                <button type="button" className="rf-menu-del" aria-label={`删除常用问题：${q.text}`} title="删除" onClick={() => void quick.remove(q.id)}>
                  ×
                </button>
              </div>
            ))}
            <div className="rf-menu-add">
              <input
                className="rf-menu-input"
                aria-label="添加常用问题"
                placeholder="添加常用问题"
                maxLength={MAX_QUICK_QUESTION_CHARS}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setAddError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void saveDraft();
                  }
                }}
              />
              <button type="button" className="rf-menu-check" aria-label="保存常用问题" title="保存" disabled={!draft.trim()} onClick={() => void saveDraft()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </button>
            </div>
            {addError && (
              <p className="rf-menu-error" role="alert">
                {addError}
              </p>
            )}
          </div>
        </div>
      )}
      <div className="rf-composer-box">
        <button
          ref={plus}
          type="button"
          className="rf-composer-plus"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="常用问题"
          title="常用问题"
          onClick={toggleMenu}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
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
        {text.trim() !== "" && (
          <button type="button" className="rf-composer-send" disabled={busy} onClick={send} aria-label="发送问题" title="发送（Enter）">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

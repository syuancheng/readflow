"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_CATEGORY } from "@/lib/categories";

/**
 * 分类选择：自绘的下拉（不用浏览器原生弹层，避免系统深色模式下变成半透明黑）。
 * 候选分类由外部传入（预设 + 库中自定义，与编辑弹窗同源），末尾可再输入新分类。
 */
export default function CategoryPicker({
  value,
  categories,
  onChange,
}: {
  value: string;
  /** 全部分类候选（预设 + 库中自定义） */
  categories: readonly string[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (custom) inputRef.current?.focus();
  }, [custom]);

  function pick(v: string) {
    onChange(v);
    setCustom(false);
    setOpen(false);
  }

  if (custom) {
    return (
      <div className="rf-catpick-custom mb-3">
        <input
          ref={inputRef}
          className="duo-input"
          aria-label="自定义分类"
          placeholder="输入分类名"
          maxLength={MAX_CATEGORY}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="duo-btn duo-btn-white duo-btn-sm" onClick={() => pick("")}>
          取消
        </button>
      </div>
    );
  }

  const isPreset = categories.includes(value);
  return (
    <div className="rf-catpick mb-3" ref={rootRef}>
      <button
        type="button"
        className="duo-input rf-catpick-btn"
        aria-label="文章分类"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={value ? "" : "rf-catpick-ph"}>{value || "选择分类（可选）"}</span>
      </button>
      {open && (
        <ul className="rf-catpick-list" role="listbox" aria-label="文章分类">
          {categories.map((c) => (
            <li key={c} role="option" aria-selected={value === c}>
              <button type="button" className={`rf-catpick-opt${value === c ? " rf-catpick-opt-on" : ""}`} onClick={() => pick(c)}>
                {c}
              </button>
            </li>
          ))}
          <li role="option" aria-selected={!!value && !isPreset}>
            <button type="button" className="rf-catpick-opt rf-catpick-opt-custom" onClick={() => { onChange(""); setCustom(true); setOpen(false); }}>
              ＋ 自定义…
            </button>
          </li>
          {value && (
            <li role="option" aria-selected={false}>
              <button type="button" className="rf-catpick-opt rf-catpick-opt-clear" onClick={() => pick("")}>
                不选分类
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

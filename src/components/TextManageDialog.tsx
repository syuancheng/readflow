"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** 分类预设。存库的是字符串本身；自定义值直接入库，前端映射放这里 */
export const CATEGORIES = [
  "技术文档",
  "文学",
  "博客",
  "新闻",
  "论文",
  "教程",
  "其他",
] as const;

const MAX_TITLE = 200;
const MAX_CATEGORY = 30;

export type TextMeta = {
  id: string;
  title: string;
  category: string | null;
  createdAt: number;
  wordCount: number;
  cefrLevel: string | null;
};

/**
 * 文本编辑弹窗（P16）：重命名 / 分类 / 查看创建信息 / 删除。
 *
 * 删除是两段式确认：点「删除这篇文本」后按钮原地变成红色「再点一次确认删除」，
 * 5 秒不点自动复原。比「模态里再开一个模态」顺手，也比 window.confirm 合界面。
 * 删除语义与 DELETE /api/texts/{id} 对齐：词库 / 原句 / AI 释义全部保留。
 */
export default function TextManageDialog({
  meta,
  onClose,
  onSaved,
  onDeleted,
}: {
  meta: TextMeta;
  onClose: () => void;
  /** 元数据保存成功（父组件刷新列表或同步本地状态） */
  onSaved: (next: { title: string; category: string | null }) => void;
  /** 文本已删除 */
  onDeleted: (id: string) => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(meta.title);
  const [category, setCategory] = useState<string | null>(meta.category);
  const [customInput, setCustomInput] = useState(
    meta.category && !CATEGORIES.includes(meta.category as (typeof CATEGORIES)[number])
      ? meta.category
      : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty = title.trim() !== meta.title || category !== meta.category;

  // Esc 关闭（删除确认态一并复位）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  function resetConfirm() {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(false);
  }

  function pickCategory(c: string | null) {
    setCategory(c);
    setCustomInput(c === null ? "" : CATEGORIES.includes(c as (typeof CATEGORIES)[number]) ? "" : c);
  }

  async function save() {
    const t = title.trim();
    if (!t) {
      setError("标题不能为空");
      return;
    }
    if (t.length > MAX_TITLE) {
      setError(`标题太长（上限 ${MAX_TITLE} 字符）`);
      return;
    }
    if (category && category.length > MAX_CATEGORY) {
      setError(`分类名太长（上限 ${MAX_CATEGORY} 字符）`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/texts/${meta.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t, category: category ?? "" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `保存失败（${res.status}）`);
      }
      onSaved({ title: t, category });
      onClose();
      router.refresh(); // 右侧统计 / 服务端数据同步
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!confirming) {
      setConfirming(true);
      // 5 秒不点第二次自动复原：手误点到第一段不会有任何后果
      confirmTimer.current = setTimeout(() => setConfirming(false), 5000);
      return;
    }
    resetConfirm();
    setDeleting(true);
    try {
      const res = await fetch(`/api/texts/${meta.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      onDeleted(meta.id);
      onClose();
      router.refresh();
    } catch {
      setError("删除失败，请重试");
      setDeleting(false);
    }
  }

  return (
    <div className="tm-overlay" onClick={onClose}>
      <div
        className="tm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`编辑文本 ${meta.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tm-head">
          <h2>编辑文本</h2>
          <button type="button" className="tm-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="tm-body">
          <label className="tm-label" htmlFor="tm-title">
            标题
          </label>
          <input
            id="tm-title"
            className="duo-input"
            value={title}
            maxLength={MAX_TITLE}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />

          <label className="tm-label">分类</label>
          <div className="tm-cats">
            <button
              type="button"
              className={`duo-filter-chip${category === null ? " duo-filter-chip-on" : ""}`}
              onClick={() => pickCategory(null)}
            >
              未分类
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`duo-filter-chip${category === c ? " duo-filter-chip-on" : ""}`}
                onClick={() => pickCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <input
            className="duo-input tm-cat-custom"
            placeholder="或自定义分类名（回车应用）…"
            maxLength={MAX_CATEGORY}
            value={customInput}
            onChange={(e) => {
              setCustomInput(e.target.value);
              setCategory(e.target.value.trim() || null);
            }}
          />

          <label className="tm-label">信息</label>
          <p className="tm-meta">
            创建于 {new Date(meta.createdAt).toLocaleString("zh-CN")} ·{" "}
            {meta.wordCount.toLocaleString()} 词
            {meta.cefrLevel ? ` · 难度 ${meta.cefrLevel}` : ""}
          </p>

          {error && <p className="tm-error">{error}</p>}

          <div className="tm-actions">
            <button
              type="button"
              className="duo-btn duo-btn-primary"
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            <button type="button" className="duo-btn duo-btn-white" onClick={onClose}>
              取消
            </button>
          </div>

          <div className="tm-danger">
            <p className="tm-danger-note">阅读时收的词、原句和 AI 释义都会保留在词库里。</p>
            <button
              type="button"
              className={confirming ? "tm-del-btn is-armed" : "tm-del-btn"}
              onClick={onDelete}
              disabled={deleting}
            >
              {deleting ? "删除中…" : confirming ? "再点一次确认删除" : "删除这篇文本"}
            </button>
            {confirming && !deleting && (
              <button type="button" className="tm-del-cancel" onClick={resetConfirm}>
                手滑了，不删
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 文本卡片的删除按钮。
 *
 * 放在 <li> 的绝对定位层（与 Link 平级，不嵌套——a 里塞 button 是非法 HTML）。
 * 删除语义（与 DELETE /api/texts/{id} 对齐）：
 *   - 删：texts + paragraphs（级联）+ section_summaries（级联）
 *   - 留：user_words / contexts（阅读时收的词、原句、AI 释义）/ exports
 * 确认弹窗里把「记录会保留」讲清楚，避免用户因为怕丢词库而不敢删。
 */
export default function DeleteTextButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    if (
      !window.confirm(
        `删除「${title}」？\n\n正文和段落会被移除；阅读时收的词、原句和 AI 释义都会保留在词库里。`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/texts/${id}`, { method: "DELETE" });
      if (res.ok) router.refresh();
    } catch {
      /* 静默失败：留在列表里，用户可以重试 */
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="duo-text-del"
      onClick={onDelete}
      disabled={busy}
      title="删除这篇文本（词库记录保留）"
      aria-label={`删除文本 ${title}`}
    >
      ×
    </button>
  );
}

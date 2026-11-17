"use client";

import { useSyncExternalStore } from "react";
import { dismissToast, getServerToasts, getToasts, subscribeToasts } from "@/lib/card-toast-store";

/**
 * 做卡完成通知（P43）：右上角（顶栏下方），挂在整站布局里，不依赖阅读页右栏。
 * 用户不会一直守在右栏等卡做好——切到别的词、甚至去了别的页面，做完都会在这里提醒，
 * 点「查看」在新标签页打开卡片，当前的阅读位置不丢。
 */
export default function CardToasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  if (toasts.length === 0) return null;

  return (
    <div className="rf-toasts" role="region" aria-label="通知">
      {toasts.map((t) => (
        <div key={t.id} className={`rf-toast rf-toast-${t.kind}`} role="status">
          <span className="rf-toast-icon" aria-hidden>
            {t.kind === "ready" ? "✓" : "!"}
          </span>
          <div className="rf-toast-body">
            <p className="rf-toast-title">{t.kind === "ready" ? `已做成 ${t.count} 张卡` : "做卡失败"}</p>
            <p className="rf-toast-sub">
              {t.word}
              {t.kind === "failed" && t.detail ? ` · ${t.detail}` : ""}
            </p>
          </div>
          {t.kind === "ready" && t.href && (
            <a
              className="duo-btn duo-btn-sm duo-btn-white"
              href={t.href}
              target="_blank"
              rel="noreferrer"
              // 延后一拍再关：同步移除链接元素，可能赶在浏览器「打开新标签页」之前把它摘掉
              onClick={() => setTimeout(() => dismissToast(t.id), 0)}
            >
              查看
            </a>
          )}
          <button type="button" className="rf-toast-close" aria-label="关闭通知" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

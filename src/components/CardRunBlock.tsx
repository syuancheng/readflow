"use client";

import type { CSSProperties } from "react";
import type { CardStatus } from "@/lib/chat-view";
import { cardViewHref } from "@/lib/card-jobs";
import type { CardState } from "@/lib/use-card-job";

/**
 * 对话流里的做卡状态块（P44）：像 AI 执行一次工具调用。
 * 四种状态都在原位变化，不整块换元素：进行中 / 成功 / 失败 / 已推到墨墨。
 * 失败的原因和「重试」就留在这里，和 Claude 里工具失败的处理一致。
 */
export default function CardRunBlock({
  status,
  st,
  pct,
  eta,
  error,
  onRetry,
}: {
  status: CardStatus;
  st: CardState | null;
  pct: number;
  eta: number;
  error: string;
  /** 失败后重试 */
  onRetry: () => void;
}) {
  return (
    <div className="rf-run-block" data-state={status} aria-live="polite" aria-busy={status === "generating"}>
      {status === "generating" && (
        <>
          <span className="rf-progress-ring" style={{ "--rf-pct": pct } as CSSProperties} aria-hidden />
          <span>正在做卡 {pct}%</span>
          <span className="rf-run-note">{eta > 0 ? `预计还需约 ${eta} 秒 · 估算` : "正在收尾，马上就好…"}</span>
        </>
      )}
      {status === "ready" && (
        <>
          <span aria-hidden>✓</span>
          <a
            className="rf-run-link"
            href={cardViewHref(st?.wordId ?? null)}
            target="_blank"
            rel="noreferrer"
            title="在新标签页打开卡片，读完可以继续在这里阅读"
          >
            已做成 {st?.count} 张卡 · 查看
          </a>
        </>
      )}
      {status === "failed" && (
        <>
          <span role="alert">做卡失败{st?.error ? `：${st.error}` : ""}</span>
          <button type="button" className="rf-run-action" onClick={onRetry}>
            重试
          </button>
        </>
      )}
      {status === "pushed" && (
        <>
          <span aria-hidden>✓</span>
          <span>已在墨墨</span>
        </>
      )}
      {error && status !== "failed" && (
        <span className="rf-run-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

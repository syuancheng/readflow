"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** /api/cards/state 的返回（PRD F2 的五种状态） */
type CardState = {
  enabled: boolean;
  state: "none" | "generating" | "ready" | "failed" | "pushed";
  setId: string | null;
  count: number;
  error: string | null;
  wordId: string | null;
};

const POLL_MS = 2000;
const POLL_MAX = 120; // 4 分钟；服务端 5 分钟没结束会自己标失败

/**
 * 阅读页右栏「＋ 做成卡片」按钮（P33 F2）。
 * - 生成在后台进行，不阻塞阅读：状态每 2 秒查一次，切到别的词也不会中断（服务端自己在跑）。
 * - 有 AI 建议时用紫色强调；没有建议时用普通白色小按钮；不用绿色（右栏已有主操作）。
 */
export default function MakeCardButton({
  contextId,
  answerId,
  suggestion,
}: {
  contextId?: string;
  answerId?: string;
  /** 讲解末尾「制卡建议：」的理由；没有则 null */
  suggestion: string | null;
}) {
  const [st, setSt] = useState<CardState | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const polls = useRef(0);

  const refresh = useCallback(async (): Promise<CardState | null> => {
    if (!contextId) return null;
    try {
      const res = await fetch(`/api/cards/state?contextId=${encodeURIComponent(contextId)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as CardState;
      setSt(data);
      return data;
    } catch {
      return null;
    }
  }, [contextId]);

  // 换了一处批注：重新取状态
  useEffect(() => {
    setSt(null);
    setError("");
    polls.current = 0;
    void refresh();
  }, [refresh]);

  // 生成中：每 2 秒查一次
  const generating = st?.state === "generating";
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > POLL_MAX) {
        clearInterval(timer);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [generating, refresh]);

  async function generate(force: boolean) {
    if (!contextId || starting) return;
    setError("");
    setStarting(true);
    // 点击后立刻显示「正在做卡…」，不等服务端响应
    setSt((cur) => ({ ...(cur ?? { enabled: true, setId: null, count: 0, error: null, wordId: null }), state: "generating" }));
    try {
      const res = await fetch("/api/cards/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contextId, ...(answerId ? { answerId } : {}), ...(force ? { force: true } : {}) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "做卡失败");
        await refresh();
        return;
      }
      polls.current = 0;
      await refresh();
    } catch {
      setError("网络不通，稍后再试");
      await refresh();
    } finally {
      setStarting(false);
    }
  }

  function again() {
    if (window.confirm("再做一组新的卡吗？")) void generate(true);
  }

  if (st && !st.enabled) return null;

  const state = st?.state ?? "none";
  const suggested = suggestion !== null && (state === "none" || state === "failed");

  return (
    <div className="rf-card-action">
      {suggestion !== null && state === "none" && (
        <p className="rf-card-suggest">💡 建议做成卡片：{suggestion}</p>
      )}
      {state === "none" && (
        <button
          type="button"
          className={suggested ? "rf-card-btn rf-card-btn-suggest" : "duo-btn-sm duo-btn-white"}
          disabled={!contextId || starting}
          title={contextId ? undefined : "正在保存这条记录…"}
          onClick={() => void generate(false)}
        >
          ＋ 做成卡片
        </button>
      )}
      {state === "generating" && (
        <button type="button" className="duo-btn-sm duo-btn-white" disabled aria-busy="true">
          正在做卡…
        </button>
      )}
      {state === "ready" && (
        <span className="rf-card-done">
          <span>✓ 已做成 {st?.count} 张卡 · </span>
          <a className="rf-card-link" href={`/words?status=pending&word=${encodeURIComponent(st?.wordId ?? "")}`}>
            查看
          </a>
          <button type="button" className="rf-card-again" onClick={again}>
            再做一组
          </button>
        </span>
      )}
      {state === "failed" && (
        <button
          type="button"
          className={suggested ? "rf-card-btn rf-card-btn-suggest" : "duo-btn-sm duo-btn-white"}
          title={st?.error ?? undefined}
          onClick={() => void generate(true)}
        >
          做卡失败，重试
        </button>
      )}
      {state === "pushed" && (
        <span className="rf-card-done">
          <span>✓ 已在墨墨</span>
          <button type="button" className="rf-card-again" onClick={again}>
            再做一组
          </button>
        </span>
      )}
      {error && (
        <p className="rf-card-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { bgFetch } from "@/lib/bg-fetch";
import { trackCardJob } from "@/lib/card-toast-store";

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
 * - 与「问 AI」同一个按钮底盘（按下有反馈）；有建议时只多一点紫色点缀，不用绿色（右栏已有主操作）。
 */
export default function MakeCardButton({
  contextId,
  answerId,
  suggestion,
  word,
}: {
  contextId?: string;
  answerId?: string;
  /** 通知里显示的词（P43） */
  word?: string;
  /** 讲解末尾「制卡建议：」的理由；没有则 null */
  suggestion: string | null;
}) {
  const [st, setSt] = useState<CardState | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const polls = useRef(0);
  // 服务端只给「generating」，没有真实百分比。这里按已等待时间给一条
  // 明确标注为「估算」的进度曲线：到 95% 就停住，等真实状态落地再收尾。
  const [progressStart, setProgressStart] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async (): Promise<CardState | null> => {
    if (!contextId) return null;
    try {
      const res = await bgFetch(`/api/cards/state?contextId=${encodeURIComponent(contextId)}`);
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
    if (!generating) {
      setProgressStart(null);
      return;
    }
    setProgressStart((cur) => cur ?? Date.now());
    setTick(Date.now());
    // P43：做卡在后台跑，用户可能切走。登记到页面级跟踪器，做完会在右上角弹通知；重复登记无副作用
    if (contextId) trackCardJob({ contextId, word: word ?? "", setId: st?.setId ?? null });
    const ticker = setInterval(() => setTick(Date.now()), 200);
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > POLL_MAX) {
        clearInterval(timer);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      clearInterval(ticker);
    };
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
      if (contextId) trackCardJob({ contextId, word: word ?? "", setId: (data as { setId?: string } | null)?.setId ?? null });
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
  const elapsedSec = progressStart ? Math.max(0, Math.floor((tick - progressStart) / 1000)) : 0;
  const pct = Math.min(95, Math.round(100 * (1 - Math.exp(-elapsedSec / 20))));
  const eta = Math.max(0, 45 - elapsedSec);
  const suggested = suggestion !== null && (state === "none" || state === "failed");
  // 与「问 AI」同一个按钮底盘（.duo-btn-sm.duo-btn-white）：高度、圆角、按下反馈都一致；
  // 有建议时只多一点紫色点缀。各状态在原位变化，不整块换成别的元素。
  const cls = `duo-btn duo-btn-sm duo-btn-white rf-card-btn${suggested ? " rf-card-btn-suggest" : ""}`;

  // 注意：这是一个片段，直接放进父级的 flex 行里；建议条用 order:-1 排到按钮组上方
  return (
    <>
      {suggestion !== null && state === "none" && (
        <p className="rf-card-suggest">
          💡 <b>建议做成卡片：</b>
          {suggestion}
        </p>
      )}
      {state === "none" && (
        <button
          type="button"
          className={cls}
          disabled={!contextId || starting}
          title={contextId ? undefined : "正在保存这条记录…"}
          onClick={() => void generate(false)}
        >
          ＋ 做成卡片
        </button>
      )}
      {state === "generating" && (
        <>
          <button
            type="button"
            className={cls}
            disabled
            aria-busy="true"
            title="生成在后台进行，离开这里也不会中断"
          >
            <span
              className="rf-progress-ring"
              style={{ "--rf-pct": pct } as CSSProperties}
              aria-hidden
            />
            做卡 {pct}%
          </button>
          <p className="rf-card-progress-note" aria-live="polite">
            {eta > 0 ? `预计还需约 ${eta} 秒 · 估算` : "正在收尾，马上就好…"}
          </p>
        </>
      )}
      {state === "ready" && (
        <>
          <a
            className={cls}
            href={`/words?status=pending&word=${encodeURIComponent(st?.wordId ?? "")}`}
            target="_blank"
            rel="noreferrer"
            title="在新标签页打开卡片，读完可以继续在这里阅读"
          >
            ✓ 已做成 {st?.count} 张卡 · 查看
          </a>
          <button type="button" className="rf-card-again" onClick={again}>
            再做一组
          </button>
        </>
      )}
      {state === "failed" && (
        <button type="button" className={cls} title={st?.error ?? undefined} onClick={() => void generate(true)}>
          做卡失败，重试
        </button>
      )}
      {state === "pushed" && (
        <>
          <button type="button" className={cls} disabled>
            ✓ 已在墨墨
          </button>
          <button type="button" className="rf-card-again" onClick={again}>
            再做一组
          </button>
        </>
      )}
      {error && (
        <p className="rf-card-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

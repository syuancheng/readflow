"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bgFetch } from "./bg-fetch";
import { trackCardJob } from "./card-toast-store";
import { cardProgress, type CardStatus } from "./chat-view";

/** /api/cards/state 的返回（PRD F2 的五种状态） */
export type CardState = {
  enabled: boolean;
  state: CardStatus;
  setId: string | null;
  count: number;
  error: string | null;
  wordId: string | null;
};

const POLL_MS = 2000;
const POLL_MAX = 120; // 4 分钟；服务端 5 分钟没结束会自己标失败

/**
 * 做卡任务的状态（P44：从 MakeCardButton 抽出来，展示交给对话流里的状态块）。
 * - 生成在后台进行，不阻塞阅读：状态每 2 秒查一次，切到别的词也不会中断（服务端自己在跑）。
 * - 点击后立刻显示「正在做卡」，不等服务端响应；P43 的页面级通知跟踪照旧。
 */
export function useCardJob({ contextId, word, answerId }: { contextId?: string; word?: string; answerId?: string }) {
  const [st, setSt] = useState<CardState | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const polls = useRef(0);
  // 服务端只给「generating」，没有真实百分比：按已等待时间给一条标注为「估算」的曲线
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

  const start = useCallback(
    async (force: boolean) => {
      if (!contextId || starting) return;
      setError("");
      setStarting(true);
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
        trackCardJob({ contextId, word: word ?? "", setId: (data as { setId?: string } | null)?.setId ?? null });
        await refresh();
      } catch {
        setError("网络不通，稍后再试");
        await refresh();
      } finally {
        setStarting(false);
      }
    },
    [contextId, answerId, word, starting, refresh],
  );

  const elapsedSec = progressStart ? Math.max(0, Math.floor((tick - progressStart) / 1000)) : 0;
  return {
    /** 功能没开（站长关了）时整个入口都不显示 */
    enabled: !(st && !st.enabled),
    status: (st?.state ?? "none") as CardStatus,
    st,
    error,
    starting,
    ...cardProgress(elapsedSec),
    start,
  };
}

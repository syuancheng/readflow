"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bgFetch } from "./bg-fetch";
import { subscribeCardState, trackCardJob } from "./card-toast-store";
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

/**
 * 做卡任务的状态（P44：从 MakeCardButton 抽出来，展示交给对话流里的状态块）。
 * - 生成在后台进行，不阻塞阅读：全站只有 card-toast-store 的跟踪器一路轮询（每 3 秒），
 *   这里订阅它的结果，不再自己开定时器；切到别的词也不会中断（服务端自己在跑）。
 * - 点击后立刻显示「正在做卡」，不等服务端响应；P43 的页面级通知跟踪照旧。
 */
export function useCardJob({ contextId, word, answerId }: { contextId?: string; word?: string; answerId?: string }) {
  const [st, setSt] = useState<CardState | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  // 这次点击得到的 setId：跟踪器偶尔会带回上一组遗留的「已完成」，对不上的忽略
  const expectedSet = useRef<string | null>(null);
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
    expectedSet.current = null;
    void refresh();
  }, [refresh]);

  // 订阅全局跟踪器查回来的状态
  useEffect(() => {
    if (!contextId) return;
    return subscribeCardState(contextId, (s) => {
      const exp = expectedSet.current;
      if (exp && s.setId && s.setId !== exp) return;
      setSt((prev) => ({ enabled: prev?.enabled ?? true, ...s }));
    });
  }, [contextId]);

  const generating = st?.state === "generating";
  useEffect(() => {
    if (!generating) {
      setProgressStart(null);
      return;
    }
    setProgressStart((cur) => cur ?? Date.now());
    setTick(Date.now());
    // P43：做卡在后台跑，用户可能切走。登记到页面级跟踪器：它负责轮询、弹通知，并把状态广播给这里。
    // 要等拿到 setId 再登记（乐观状态里还没有），否则会认不出上一组遗留的结果；重复登记无副作用
    if (contextId && st?.setId) trackCardJob({ contextId, word: word ?? "", setId: st.setId });
    const ticker = setInterval(() => setTick(Date.now()), 200);
    return () => clearInterval(ticker);
  }, [generating, contextId, st?.setId]);

  const start = useCallback(
    async (force: boolean) => {
      if (!contextId || starting) return;
      setError("");
      setStarting(true);
      // setId 清空：重新做卡（force）时 cur 里还是上一组的 id，不能拿它去登记跟踪器
      setSt((cur) => ({ ...(cur ?? { enabled: true, count: 0, error: null, wordId: null }), setId: null, state: "generating" }));
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
        const setId = (data as { setId?: string; reused?: boolean } | null)?.setId ?? null;
        expectedSet.current = setId;
        if (setId) {
          // 刚点下去，服务端一定还在 generating：直接补上 setId（触发登记跟踪器），不必再查一次
          setSt((cur) => (cur ? { ...cur, setId } : cur));
          trackCardJob({ contextId, word: word ?? "", setId });
        }
        // 去重命中已有的一组（可能早已做完）：查一次真实状态；否则交给跟踪器 3 秒后的第一次轮询
        if ((data as { reused?: boolean } | null)?.reused || !setId) await refresh();
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

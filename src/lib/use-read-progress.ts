"use client";

import { useEffect, useRef, useState } from "react";
import { currentBlockIdx, scrollProgress, type BlockPosition } from "@/lib/read-progress";

/**
 * 阅读进度的计算与上报（P18 逻辑，P19 从 ReadProgressPill 抽成 hook）。
 *
 * 这里**不含任何 UI**：常驻顶栏（ReadingChrome）消费返回值自己渲染数字、
 * 底边进度条和「标记已读完」按钮。抽出来的原因是顶栏常驻后，进度 UI 与
 * 顶栏其它元素在同一行，不再适合由一个小徽章组件自己 return 一段 JSX。
 *
 * 逻辑与 P18 定稿完全一致，一处都没改：
 *   - 进度 = 滚动条位置（实时、可下降、滚到底＝100%）；
 *   - 已读完 = 用户显式断言（completed_at / null），100% 不自动等于读完；
 *   - 滚动停止 350ms 即上报（2s interval 兜底），卸载用 sendBeacon 投递。
 */
export type ReadProgressState = {
  ratio: number;
  pct: number;
  atBottom: boolean;
  done: boolean;
  busy: boolean;
  toggleCompleted: () => void;
};

export function useReadProgress({
  textId,
  initialRatio,
  initialCompletedAt,
}: {
  textId: string;
  initialRatio: number | null;
  initialCompletedAt: number | null;
}): ReadProgressState {
  const [ratio, setRatio] = useState(() => Math.min(Math.max(initialRatio ?? 0, 0), 1));
  const [completedAt, setCompletedAt] = useState<number | null>(initialCompletedAt);
  const [busy, setBusy] = useState(false);

  const ratioRef = useRef(ratio);
  const idxRef = useRef(-1);
  const dirtyRef = useRef(false);
  ratioRef.current = ratio;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const measure = () => {
      if (disposed) return;
      const metrics = {
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
      };
      const nextRatio = scrollProgress(metrics);

      // 只算「读到线」以上的块：视口 75% 深度对应的文档坐标。
      // 这里取当前位置（可回退），不再是全 DOM 的最大 idx。
      const readLine = metrics.scrollY + metrics.innerHeight * 0.75;
      const positions: BlockPosition[] = [];
      document.querySelectorAll<HTMLElement>("[data-idx]").forEach((el) => {
        const idx = Number(el.dataset.idx);
        if (Number.isInteger(idx)) {
          positions.push({ idx, top: el.getBoundingClientRect().top + metrics.scrollY });
        }
      });
      const nextIdx = currentBlockIdx(positions, readLine);

      if (nextRatio !== ratioRef.current || nextIdx !== idxRef.current) {
        ratioRef.current = nextRatio;
        idxRef.current = nextIdx;
        dirtyRef.current = true;
        setRatio(nextRatio);
      }
    };

    const report = (keepalive: boolean) => {
      if (!dirtyRef.current) return;
      const payload: { readRatio: number; readIdx?: number } = { readRatio: ratioRef.current };
      if (idxRef.current >= 0) payload.readIdx = idxRef.current;
      const url = `/api/texts/${textId}`;
      const body = JSON.stringify(payload);
      dirtyRef.current = false;

      // 页面销毁 / 切后台时 fetch keepalive 实测会丢（滚完立刻关标签页，
      // 进度停在旧值）。sendBeacon 专为卸载场景设计，浏览器保证投递。
      if (keepalive && typeof navigator.sendBeacon === "function") {
        try {
          if (navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return;
        } catch {
          // 落到 fetch 兜底
        }
      }
      void fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive,
      }).catch(() => {
        dirtyRef.current = true; // 下个周期重试
      });
    };

    // 滚动停止 350ms 就立即上报，不再干等 2s 定时器 ——「滚完就退出」是
    // 最常见的使用方式，2s 窗口内的最后一次进度必须落库。
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        measure();
        report(false);
      }, 350);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    measure(); // 打开页面先按真实位置校准

    const reportTimer = setInterval(() => report(false), 2000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") report(true);
    };
    const onHide = () => report(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearInterval(reportTimer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      report(true); // 路由跳走时补报最后一次位置
    };
  }, [textId]);

  /** 「标记已读完」是 toggle：再点一次传 null 取消。不设独立的重置按钮。 */
  async function toggleCompleted() {
    if (busy) return;
    const previous = completedAt;
    const next = previous === null ? Date.now() : null;
    setCompletedAt(next); // 乐观更新
    setBusy(true);
    try {
      // 顺手把当前位置一起写进去：用户常常「滚到底 → 立刻标记 → 立刻返回」，
      // 只靠 2s 节流上报来不及，首页会出现「已读完」但进度还是旧值的不一致。
      const payload: { completedAt: number | null; readRatio: number; readIdx?: number } = {
        completedAt: next,
        readRatio: ratioRef.current,
      };
      if (idxRef.current >= 0) payload.readIdx = idxRef.current;
      const res = await fetch(`/api/texts/${textId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setCompletedAt(previous); // 失败回滚，刷新页面由服务端值兜底
    } finally {
      setBusy(false);
    }
  }

  return {
    ratio,
    pct: Math.round(ratio * 100),
    atBottom: ratio >= 1,
    done: completedAt !== null,
    busy,
    toggleCompleted,
  };
}

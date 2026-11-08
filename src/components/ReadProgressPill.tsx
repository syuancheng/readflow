"use client";

import { useEffect, useRef, useState } from "react";
import { currentBlockIdx, scrollProgress, type BlockPosition } from "@/lib/read-progress";

/**
 * 阅读进度 + 「已读完」标记（P18 重写）。
 *
 * 旧版 bug：observe() 用 querySelectorAll("[data-idx]") 扫全 DOM 取最大 idx，
 * 没有任何视口判断，打开页面就把 read_ratio 写成 1；服务端又做单调合并，
 * 错误值永远降不回来。两篇没读过的文章都显示「✓ 已读完」就是这么来的。
 *
 * 现在两条独立轨道：
 *   - 进度 = 滚动条位置（实时、可下降、滚到底＝100%），2s 节流 PATCH 覆盖写；
 *   - 已读完 = 用户点按钮的显式断言（completed_at 时间戳 / null），
 *     滚到 100% 只把按钮点亮作轻提示，绝不自动写。
 *
 * 阅读页是 window 滚动（Reader 没有独立滚动容器），所以直接用 scrollY。
 * [data-idx] 仍由 Reader 渲染，这里只用它算「上次读到哪」的续读书签，
 * 不再拿它当「已读」的依据。
 */
export default function ReadProgressPill({
  textId,
  initialRatio,
  initialCompletedAt,
}: {
  textId: string;
  initialRatio: number | null;
  initialCompletedAt: number | null;
}) {
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
    measure(); // 打开页面先按真实位置校准（旧版假 1.0 在这里被改回真实值）

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

  const pct = Math.round(ratio * 100);
  const atBottom = ratio >= 1;
  const done = completedAt !== null;

  return (
    <>
      <span
        className="duo-badge duo-badge-purple"
        title="按滚动位置估算：往回翻会下降，滚到底为 100%。100% 不等于已读完"
      >
        已读 {pct}%
      </span>
      <button
        type="button"
        onClick={toggleCompleted}
        disabled={busy}
        className={done || atBottom ? "duo-badge duo-badge-green" : "duo-badge"}
        style={
          done || atBottom
            ? { cursor: "pointer" }
            : {
                cursor: "pointer",
                background: "var(--duo-surface)",
                border: "2px solid var(--duo-border)",
                color: "var(--duo-ink-soft)",
              }
        }
        title={
          done
            ? "已标记读完，点击可取消"
            : atBottom
              ? "已滚到末尾：读完了就点这里标记（不会自动标记）"
              : "读完后点这里标记为已读完"
        }
      >
        {done ? "✓ 已读完" : "标记已读完"}
      </button>

      {/*
       * 滚到底时浮在视口内：标题行那个按钮此时早已滚出屏幕，若逼用户滚回
       * 顶部去点，进度会按「当前位置」合法地掉回 0%，刚读完的 100% 反而丢了。
       * 只做轻提示，不自动改完成状态。
       */}
      {atBottom && !done && (
        <span
          data-testid="read-progress-dock"
          className="duo-card"
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 60,
            display: "inline-flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            boxShadow: "0 8px 26px rgba(24, 36, 58, 0.18)",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700 }}>读到末尾了</span>
          <button
            type="button"
            onClick={toggleCompleted}
            disabled={busy}
            className="duo-btn duo-btn-primary duo-btn-sm"
          >
            标记已读完
          </button>
        </span>
      )}
    </>
  );
}

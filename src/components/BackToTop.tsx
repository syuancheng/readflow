"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { readerScroller } from "@/lib/reader-scroll";

/** 滚过多少像素才出现 */
const SHOW_AFTER_PX = 400;

/**
 * 一键回到顶部（P49）。往下滚过一段才出现；点一下平滑滚回最上面。
 * - 整页滚动的页面（首页、词库、窄屏的阅读页……）：固定在窗口右下角；
 * - 阅读页宽屏（正文自己是滚动区）：挂进正文栏，贴在正文栏的右下角，不压在 AI 栏上。
 */
export default function BackToTop() {
  const pathname = usePathname();
  const [show, setShow] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const update = () => {
      const sc = readerScroller();
      setHost(sc);
      setShow((sc ? sc.scrollTop : window.scrollY) > SHOW_AFTER_PX);
    };
    // 捕获阶段挂在 document 上：整页滚动和正文自己滚动都能收到
    document.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      document.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
    };
  }, [pathname]);

  if (!show) return null;

  const button = (
    <button
      type="button"
      className={`rf-totop${host ? " rf-totop-in" : ""}`}
      aria-label="回到顶部"
      title="回到顶部"
      onClick={() => {
        const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
        (host ?? window).scrollTo({ top: 0, behavior });
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  );
  // 挂进正文栏时包一层高度为 0 的粘性容器：按钮浮在正文栏右下角，但不增加滚动高度，
  // 否则滚到底时读进度会因为多出来的这几十像素算不到 100%。
  return host ? createPortal(<div className="rf-totop-slot">{button}</div>, host) : button;
}

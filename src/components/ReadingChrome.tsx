"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import CefrBadge from "./CefrBadge";
import { useReadProgress } from "@/lib/use-read-progress";
import type { CefrDetail, CefrLevel } from "@/lib/cefr";

/**
 * 阅读页外壳（P19）：常驻窄条 + 默认收起的目录 + 原样的阅读器。
 *
 * 为什么包在外面而不是改 Reader：右侧批注栏是 Reader 内部 .reader-split 的
 * 一部分，页面层做不了「目录 | 正文 | 批注栏」三栏 grid。这里用两列 grid
 * （目录 | 整个 Reader），目录展开时挤压的是 Reader 整体宽度，点词坐标、
 * 批注栏、ReaderShell 全都不用动 —— 锚点契约（data-pid / 字符偏移）不变。
 *
 * 顶栏用 --font-sans（DM Sans），**不**用 --font-nav：Outfit 只给站点级
 * SiteHeader，而阅读页本来就把 SiteHeader 整条隐藏了。
 */
export type TocHeading = { id: string; depth: number; text: string };

type Props = {
  textId: string;
  title: string;
  wordCount: number;
  blockCount: number;
  category: string | null;
  sourceUrl: string | null;
  cefrLevel: CefrLevel | null;
  cefrScore: number | null;
  cefrDetail: CefrDetail | null;
  initialRatio: number | null;
  initialCompletedAt: number | null;
  headings: TocHeading[];
  children: React.ReactNode;
};

export default function ReadingChrome(props: Props) {
  const [tocOpen, setTocOpen] = useState(false);
  const [activeId, setActiveId] = useState("");
  const { ratio, pct, atBottom, done, busy, toggleCompleted } = useReadProgress({
    textId: props.textId,
    initialRatio: props.initialRatio,
    initialCompletedAt: props.initialCompletedAt,
  });

  const hasToc = props.headings.length > 0;

  // 目录高亮：最后一个越过读线的标题即「当前所在章节」
  useEffect(() => {
    if (!hasToc) return;
    const onScroll = () => {
      let cur = "";
      for (const h of props.headings) {
        const el = document.querySelector(`[data-pid="${h.id}"]`);
        if (el && el.getBoundingClientRect().top <= 112) cur = h.id;
      }
      setActiveId(cur);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
    // headings 来自服务端 RSC props，引用稳定；用长度兜住极端情况
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToc]);

  function onTocClick(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    e.preventDefault();
    const el = document.querySelector(`[data-pid="${id}"]`);
    if (!el) return;
    // 手动减掉 sticky 顶栏高度：不用 scroll-margin-top，免得影响 Reader 里
    // focusParaId 的 scrollIntoView({block:"center"}) 续读定位。
    const top = el.getBoundingClientRect().top + window.scrollY - 78;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    if (window.innerWidth <= 720) setTocOpen(false);
  }

  return (
    <>
      <header className="rf-topbar">
        <div className="rf-tb-left">
          <button
            type="button"
            className="rf-icon-btn"
            aria-label={tocOpen ? "收起目录" : "展开目录"}
            aria-expanded={tocOpen}
            title={hasToc ? (tocOpen ? "收起目录" : "展开目录") : "本文没有标题，无法生成目录"}
            disabled={!hasToc}
            onClick={() => setTocOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="rf-tb-sep" />
          <Link href="/" className="rf-back">
            ← <span>返回我的文本</span>
          </Link>
          <span className="rf-tb-sep" />
          <h1 className="rf-tb-title" title={props.title}>
            {props.title}
          </h1>
        </div>

        <div className="rf-tb-right">
          <CefrBadge level={props.cefrLevel} score={props.cefrScore} detail={props.cefrDetail} />
          <span
            className="rf-progress"
            title="按滚动位置估算：往回翻会下降，滚到底为 100%。100% 不等于已读完"
          >
            已读 <b>{pct}</b>%
          </span>
          <button
            type="button"
            className={`rf-done-btn${done ? " done" : atBottom ? " at-bottom" : ""}`}
            onClick={toggleCompleted}
            disabled={busy}
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
          {props.sourceUrl && (
            <a
              className="rf-source"
              href={props.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              查看原文 ↗
            </a>
          )}
        </div>

        <div className="rf-tb-progress">
          <i style={{ width: `${ratio * 100}%` }} />
        </div>
      </header>

      <div className={`rf-reading-layout${tocOpen && hasToc ? " toc-open" : ""}`}>
        <aside className="rf-toc" aria-hidden={!tocOpen}>
          <div className="rf-toc-inner">
            <div className="rf-toc-head">
              目录
              <button type="button" onClick={() => setTocOpen(false)} aria-label="收起目录">
                ×
              </button>
            </div>
            <div className="rf-toc-meta">
              {props.wordCount.toLocaleString()} 词 · {props.blockCount} 块
              {props.category ? ` · ${props.category}` : ""}
            </div>
            {hasToc ? (
              <nav className="rf-toc-nav">
                {props.headings.map((h) => (
                  <a
                    key={h.id}
                    href={`#${h.id}`}
                    data-target={h.id}
                    title={h.text}
                    className={`rf-toc-item lv${Math.min(Math.max(h.depth, 1), 4)}${
                      activeId === h.id ? " active" : ""
                    }`}
                    onClick={(e) => onTocClick(e, h.id)}
                  >
                    {h.text}
                  </a>
                ))}
              </nav>
            ) : (
              <p className="rf-toc-empty">本文没有标题，无法生成目录。</p>
            )}
          </div>
        </aside>

        <div className="rf-reading-main">
          <div className="max-w-[1440px] mx-auto px-6 py-7">{props.children}</div>
        </div>
      </div>
    </>
  );
}

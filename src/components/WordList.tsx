"use client";

/**
 * 词库（P27 改版）：布局参照 Readlang 的词表 —— 左侧筛选栏、右侧紧凑词表、批量操作、排序；
 * 视觉保持多邻国风格（粗边框 + 底部阴影、大圆角、绿色主色、按下有「下沉」手感）。
 *
 * 一行一个词：勾选 / 发音 / 星标 / 原句片段（生词加粗）/ 简短中文 / 来源文章；
 * 点一行展开详情（音标、词性、完整释义、这篇文章里的全部原句、删除）。
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { normalizePhonetic, normalizeTranslation } from "@/lib/text";
import { speak } from "@/lib/speak";
import MarkdownText from "@/components/MarkdownText";
import type { ExportBadge, Snippet } from "@/lib/word-library";

export type WordContextRow = {
  id: string;
  sentence: string;
  snippet: Snippet;
  textId: string | null;
  paragraphId: string | null;
  textTitle: string;
  /** 来源文章已被删除：原句和释义仍展示，但不再提供「跳到原文」 */
  textDeleted?: boolean;
};

export type WordRow = {
  id: string;
  lemma: string;
  displayForm: string;
  phonetic: string | null;
  pos: string | null;
  translation: string;
  /** 词表一行里的简短中文 */
  meaning: string;
  starred: number;
  isPhrase: number;
  /** 归属文章（最近查它的那篇）；已删除的文章是 DELETED_ARTICLE */
  articleKey: string | null;
  /** 最近一次查它的时间 */
  lastAt: number;
  /** 导出到各卡片应用的情况；空数组 = 未导出 */
  exported: ExportBadge[];
  /** 只含归属文章里的原句，最新在前 */
  contexts: WordContextRow[];
};

export type ArticleOption = { key: string; title: string; count: number };

/** 状态筛选：不绑死墨墨，以后接 Anki 等也是这几档 */
type StatusFilter = "all" | "starred" | "todo" | "done";
type TypeFilter = "all" | "word" | "phrase";
type SortKey = "recent" | "oldest" | "alpha";

const DELETED_KEY = "__deleted__";

/** 导出页只导这些词（词 id 是 UUID，一两百个放进网址也不超长） */
function exportHref(ids: string[]): string {
  return `/export?ids=${ids.join(",")}`;
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6.5 8.5H3v7h3.5L11 19V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  );
}

export default function WordList({
  words: initial,
  articles,
}: {
  words: WordRow[];
  articles: ArticleOption[];
}) {
  const [words, setWords] = useState(initial);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [article, setArticle] = useState<string>("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const counts = useMemo(() => {
    const c = { all: 0, starred: 0, todo: 0, done: 0 };
    for (const w of words) {
      c.all += 1;
      if (w.starred) c.starred += 1;
      if (w.exported.length) c.done += 1;
      else c.todo += 1;
    }
    return c;
  }, [words]);

  // 文章词数跟着删词实时变（初始列表来自服务端，删光的文章从列表里消失）
  const articleList = useMemo(() => {
    const n = new Map<string, number>();
    for (const w of words) if (w.articleKey) n.set(w.articleKey, (n.get(w.articleKey) ?? 0) + 1);
    return articles.filter((a) => n.get(a.key)).map((a) => ({ ...a, count: n.get(a.key) ?? 0 }));
  }, [words, articles]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = words.filter((w) => {
      if (status === "starred" && !w.starred) return false;
      if (status === "todo" && w.exported.length) return false;
      if (status === "done" && !w.exported.length) return false;
      if (article && w.articleKey !== article) return false;
      if (type === "word" && w.isPhrase) return false;
      if (type === "phrase" && !w.isPhrase) return false;
      if (q) {
        const hay = `${w.displayForm} ${w.lemma} ${w.translation}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sort === "recent") list.sort((a, b) => b.lastAt - a.lastAt);
    else if (sort === "oldest") list.sort((a, b) => a.lastAt - b.lastAt);
    else list.sort((a, b) => a.displayForm.localeCompare(b.displayForm, "en", { sensitivity: "base" }));
    return list;
  }, [words, status, type, article, query, sort]);

  const shownSelected = shown.filter((w) => selected.has(w.id));
  const allChecked = shown.length > 0 && shownSelected.length === shown.length;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) for (const w of shown) next.delete(w.id);
      else for (const w of shown) next.add(w.id);
      return next;
    });
  }

  async function setStar(ids: string[], starred: number) {
    // 乐观更新；失败由刷新页面兜底，不阻塞 UI
    setWords((prev) => prev.map((w) => (ids.includes(w.id) ? { ...w, starred } : w)));
    await Promise.allSettled(
      ids.map((id) =>
        fetch(`/api/words/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred }),
        }),
      ),
    );
  }

  /** 彻底删除：连同语境一起清掉，想再学就再查一遍（已导出到卡片应用的卡片不受影响） */
  async function remove(ids: string[]) {
    setWords((prev) => prev.filter((w) => !ids.includes(w.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    await Promise.allSettled(ids.map((id) => fetch(`/api/words/${id}`, { method: "DELETE" })));
  }

  async function batch(action: "star" | "unstar" | "delete") {
    setMenuOpen(false);
    const ids = shownSelected.map((w) => w.id);
    if (!ids.length) return;
    if (action === "delete") {
      if (!window.confirm(`删除选中的 ${ids.length} 个词？查词记录会一起删除，不能恢复。`)) return;
      await remove(ids);
    } else {
      await setStar(ids, action === "star" ? 1 : 0);
    }
  }

  const statusItems: [StatusFilter, string, number][] = [
    ["all", "全部", counts.all],
    ["starred", "★ 星标", counts.starred],
    ["todo", "未导出", counts.todo],
    ["done", "已导出", counts.done],
  ];

  return (
    <div className="wl-layout">
      {/* ---------- 左侧筛选栏 ---------- */}
      <aside className="wl-side" aria-label="筛选">
        <div className="wl-side-group">
          {statusItems.map(([k, label, n]) => (
            <button
              key={k}
              className={`wl-side-item${status === k ? " wl-side-item-on" : ""}`}
              onClick={() => setStatus(k)}
            >
              <span className="truncate">{label}</span>
              <span className="wl-side-count">{n}</span>
            </button>
          ))}
        </div>

        <div className="wl-type" role="group" aria-label="单词或短语">
          {(
            [
              ["all", "全部"],
              ["word", "单词"],
              ["phrase", "短语"],
            ] as [TypeFilter, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              className={`wl-type-btn${type === k ? " wl-type-btn-on" : ""}`}
              onClick={() => setType(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <p className="wl-side-title">文章</p>
        <div className="wl-side-group wl-side-articles">
          <button
            className={`wl-side-item${article === "" ? " wl-side-item-on" : ""}`}
            onClick={() => setArticle("")}
          >
            <span className="truncate">📚 全部文章</span>
          </button>
          {articleList.map((a) => (
            <button
              key={a.key}
              className={`wl-side-item${article === a.key ? " wl-side-item-on" : ""}`}
              onClick={() => setArticle(a.key)}
              title={a.title}
            >
              <span className="truncate">
                {a.key === DELETED_KEY ? "🗑" : "📖"} {a.title}
              </span>
              <span className="wl-side-count">{a.count}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* ---------- 右侧主区 ---------- */}
      <section className="min-w-0">
        <div className="flex items-center gap-3 mb-3">
          <div className="wl-search">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input placeholder="搜索单词或释义…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>

        <div className="wl-table">
          {/* 工具栏 */}
          <div className="wl-toolbar">
            <label className="wl-check" title={allChecked ? "取消全选" : "全选"}>
              <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="全选" />
              <span />
            </label>
            <div className="relative">
              <button
                className="wl-tool-btn"
                disabled={!shownSelected.length}
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
              >
                批量操作{shownSelected.length ? `（${shownSelected.length}）` : ""} ▾
              </button>
              {menuOpen && shownSelected.length > 0 && (
                <div className="wl-menu" role="menu">
                  <button role="menuitem" onClick={() => batch("star")}>★ 加星标</button>
                  <button role="menuitem" onClick={() => batch("unstar")}>☆ 取消星标</button>
                  <button role="menuitem" className="wl-menu-danger" onClick={() => batch("delete")}>
                    🗑 删除
                  </button>
                </div>
              )}
            </div>
            {/* 只导出勾选的词（墨墨没有删除接口，不提供「一键全部」）；想导所有未导出的：左侧「未导出」→ 全选 */}
            {shownSelected.length > 0 ? (
              <Link
                href={exportHref(shownSelected.map((w) => w.id))}
                className="duo-btn duo-btn-primary duo-btn-sm wl-export-btn"
              >
                📤 导出选中的 {shownSelected.length} 个<span className="wl-hide-sm">到墨墨</span>
              </Link>
            ) : (
              <span className="duo-btn duo-btn-sm wl-export-btn wl-export-btn-off" title="先勾选要导出的词" aria-disabled="true">
                📤 导出到墨墨
              </span>
            )}
            <span className="ml-auto text-[13px] font-bold text-ink-faint whitespace-nowrap">{shown.length} 个词</span>
            <select
              className="wl-tool-btn wl-sort"
              aria-label="排序"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="recent">最近查的</option>
              <option value="oldest">最早查的</option>
              <option value="alpha">字母顺序</option>
            </select>
          </div>

          {shown.length === 0 ? (
            <div className="duo-empty">
              <div className="duo-empty-icon">📝</div>
              <p className="text-[17px] font-bold mb-1.5">这里没有词</p>
              <p className="text-[14px] text-ink-faint">换个筛选条件，或者去阅读器里点几个词</p>
              <Link href="/" className="duo-btn duo-btn-primary mt-5">
                去读一篇
              </Link>
            </div>
          ) : (
            <ul>
              {shown.map((w) => {
                const c = w.contexts[0];
                const open = openId === w.id;
                return (
                  <li key={w.id} className={`wl-row${open ? " wl-row-open" : ""}${selected.has(w.id) ? " wl-row-checked" : ""}`}>
                    <div
                      className="wl-row-main"
                      onClick={() => setOpenId(open ? null : w.id)}
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenId(open ? null : w.id);
                        }
                      }}
                    >
                      <label className="wl-check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(w.id)}
                          onChange={() => toggleOne(w.id)}
                          aria-label={`选择 ${w.displayForm}`}
                        />
                        <span />
                      </label>
                      <button
                        className="wl-round-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          speak(w.displayForm);
                        }}
                        aria-label="发音"
                        title="发音"
                      >
                        <SpeakerIcon />
                      </button>
                      <button
                        className={`wl-round-btn wl-star${w.starred ? " wl-star-on" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setStar([w.id], w.starred ? 0 : 1);
                        }}
                        aria-label={w.starred ? "取消星标" : "星标"}
                        title={w.starred ? "取消星标" : "星标"}
                      >
                        {w.starred ? "★" : "☆"}
                      </button>

                      <p className="wl-snippet">
                        {c && c.snippet.hit ? (
                          <>
                            {c.snippet.before}
                            <b>{c.snippet.hit}</b>
                            {c.snippet.after}
                          </>
                        ) : (
                          <b>{w.displayForm}</b>
                        )}
                      </p>

                      <span className="wl-meaning">
                        {w.meaning || "—"}
                        {w.exported.map((b) => (
                          <span
                            key={b.target}
                            className="wl-export-tag"
                            title={`已导出到${b.app}：${b.cardTypes.join("、")}`}
                          >
                            {b.app} ✓
                          </span>
                        ))}
                      </span>

                      <span className="wl-source">
                        {c && !c.textDeleted && c.textId && c.paragraphId ? (
                          <Link
                            href={`/texts/${c.textId}?p=${c.paragraphId}`}
                            onClick={(e) => e.stopPropagation()}
                            title={`跳到原文：${c.textTitle}`}
                          >
                            {c.textTitle}
                          </Link>
                        ) : (
                          <span className="text-ink-faint">{c ? "已删除的文章" : ""}</span>
                        )}
                      </span>
                    </div>

                    {open && (
                      <div className="wl-detail">
                        <div className="flex items-baseline gap-2 flex-wrap mb-2">
                          <h3 className="text-[18px] font-extrabold">{w.displayForm}</h3>
                          {w.phonetic && (
                            <span className="text-[13px] font-medium text-ink-faint font-mono">
                              /{normalizePhonetic(w.phonetic)}/
                            </span>
                          )}
                          {w.isPhrase ? <span className="duo-badge duo-badge-blue">短语</span> : null}
                          {w.pos && <span className="duo-badge duo-badge-purple">{w.pos}</span>}
                          {w.exported.map((b) => (
                            <span key={b.target} className="duo-badge duo-badge-green">
                              {b.app} ✓ {b.cardTypes.join("·")}
                            </span>
                          ))}
                          <Link href={exportHref([w.id])} className="wl-export-one">
                            📤 导出这个词
                          </Link>
                          <button className="wl-delete" onClick={() => remove([w.id])} title="彻底删除">
                            🗑 删除
                          </button>
                        </div>
                        {/* 释义：AI 释义是 Markdown（标题/加粗/列表），与阅读页批注卡同一套渲染 */}
                        <div className="text-[14px] text-ink-soft font-medium mb-2">
                          <MarkdownText text={normalizeTranslation(w.translation)} />
                        </div>
                        <div className="space-y-1.5">
                          {w.contexts.map((cx) => (
                            <div key={cx.id} className="wl-sentence">
                              <p className="italic">&ldquo;{cx.sentence}&rdquo;</p>
                              <p className="text-[11px] font-bold text-ink-faint mt-1 flex items-center gap-2">
                                <span>{cx.textDeleted ? "← 来自已删除的文章" : `← ${cx.textTitle}`}</span>
                                {!cx.textDeleted && cx.textId && cx.paragraphId && (
                                  <Link
                                    href={`/texts/${cx.textId}?p=${cx.paragraphId}`}
                                    className="hover:text-[var(--duo-green-dark)] underline underline-offset-2"
                                  >
                                    跳到原文 →
                                  </Link>
                                )}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

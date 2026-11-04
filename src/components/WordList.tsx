"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { normalizePhonetic, normalizeTranslation } from "@/lib/text";
import { speak } from "@/lib/speak";
import MarkdownText from "@/components/MarkdownText";

export type WordContextRow = {
  id: string;
  sentence: string;
  textId: string | null;
  paragraphId: string | null;
  textTitle: string;
};

export type WordRow = {
  id: string;
  lemma: string;
  displayForm: string;
  phonetic: string | null;
  pos: string | null;
  translation: string;
  status: string; // learning | learned | deleted
  starred: number;
  isPhrase: number;
  contexts: WordContextRow[];
};

type StatusTab = "active" | "learning" | "learned" | "deleted" | "all";
type TypeFilter = "all" | "word" | "phrase";

const STATUS_LABEL: Record<string, string> = {
  learning: "学习中",
  learned: "已掌握",
  deleted: "已移出",
};

export default function WordList({ words: initial }: { words: WordRow[] }) {
  const [words, setWords] = useState(initial);
  const [tab, setTab] = useState<StatusTab>("active");
  const [type, setType] = useState<TypeFilter>("all");
  const [starredOnly, setStarredOnly] = useState(false);
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    // 「全部」不含已移出——已移出的词是回收站，不进主列表、不导出，
    // 只在「已移出」tab 里躺着重回/恢复
    const c = { all: 0, active: 0, learning: 0, learned: 0, deleted: 0, starred: 0 };
    for (const w of words) {
      c[w.status as keyof typeof c] = (c[w.status as keyof typeof c] ?? 0) + 1;
      if (w.status !== "deleted") {
        c.active += 1;
        c.all += 1;
        if (w.starred) c.starred += 1;
      }
    }
    return c;
  }, [words]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return words.filter((w) => {
      // 已移出的词只出现在「已移出」tab
      if (w.status === "deleted" && tab !== "deleted") return false;
      if (tab !== "active" && tab !== "all" && w.status !== tab) return false;
      if (starredOnly && !w.starred) return false;
      if (type === "word" && w.isPhrase) return false;
      if (type === "phrase" && !w.isPhrase) return false;
      if (q) {
        const hay = `${w.displayForm} ${w.lemma} ${w.translation}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [words, tab, type, starredOnly, query]);

  async function patch(id: string, body: Record<string, unknown>) {
    // 乐观更新
    setWords((prev) => prev.map((w) => (w.id === id ? { ...w, ...body } as WordRow : w)));
    try {
      const res = await fetch(`/api/words/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
    } catch {
      // 回滚由刷新页面兜底，这里不阻塞 UI
    }
  }

  return (
    <div>
      {/* 筛选区 */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {(
          [
            ["active", `词库 ${counts.active}`],
            ["learning", `学习中 ${counts.learning}`],
            ["learned", `已掌握 ${counts.learned}`],
            ["deleted", `已移出 ${counts.deleted}`],
            ["all", `全部 ${counts.all}`],
          ] as [StatusTab, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            className={`duo-filter-chip${tab === k ? " duo-filter-chip-on" : ""}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
        <button
          className={`duo-filter-chip${starredOnly ? " duo-filter-chip-on" : ""}`}
          onClick={() => setStarredOnly((v) => !v)}
        >
          ★ 星标 {counts.starred}
        </button>
        <span className="w-px h-5 bg-[var(--duo-border)] mx-1" />
        {(
          [
            ["all", "全部"],
            ["word", "单词"],
            ["phrase", "短语"],
          ] as [TypeFilter, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            className={`duo-filter-chip${type === k ? " duo-filter-chip-on" : ""}`}
            onClick={() => setType(k)}
          >
            {label}
          </button>
        ))}
        <input
          className="duo-input !w-auto flex-1 min-w-[160px] !py-2 !text-[13px]"
          placeholder="搜索单词或释义…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {shown.length === 0 ? (
        <div className="duo-card duo-empty">
          <div className="duo-empty-icon">📝</div>
          <p className="text-[17px] font-bold mb-1.5">这里没有词</p>
          <p className="text-[14px] text-ink-faint">换个筛选条件，或者去阅读器里点几个词</p>
          <Link href="/" className="duo-btn duo-btn-primary mt-5">
            去读一篇
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((w) => (
            <li key={w.id} className="duo-text-item" style={w.status === "deleted" ? { opacity: 0.55 } : undefined}>
              <div className="flex items-baseline justify-between gap-4 mb-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <h3 className="text-[17px] font-extrabold">{w.displayForm}</h3>
                  {w.phonetic && (
                    <button
                      className="text-[13px] font-medium text-ink-faint font-mono hover:text-ink cursor-pointer leading-none"
                      onClick={() => speak(w.displayForm)}
                      title="点击朗读"
                    >
                      /{normalizePhonetic(w.phonetic)}/
                    </button>
                  )}
                  {/* 无音标的词（如句子/短语）给独立发音按钮；不做 canSpeak 条件渲染——
                      那是模块加载时判断 window 的，SSR 与客户端不一致会引发 hydration 报错 */}
                  {!w.phonetic && (
                    <button
                      className="duo-speak-btn"
                      onClick={() => speak(w.displayForm)}
                      aria-label="发音"
                      title="发音"
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 5 6.5 8.5H3v7h3.5L11 19V5Z" />
                        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                      </svg>
                    </button>
                  )}
                  {w.isPhrase ? (
                    <span className="duo-badge duo-badge-blue shrink-0">短语</span>
                  ) : null}
                  {w.status !== "learning" && (
                    <span
                      className={`duo-badge shrink-0 ${
                        w.status === "learned" ? "duo-badge-green" : "duo-badge-orange"
                      }`}
                    >
                      {STATUS_LABEL[w.status]}
                    </span>
                  )}
                </div>

                {/* 行内操作：星标 / 状态 / 删除 */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="word-action-btn"
                    onClick={() => patch(w.id, { starred: w.starred ? 0 : 1 })}
                    title={w.starred ? "取消星标" : "星标"}
                    style={w.starred ? { color: "var(--duo-orange)" } : undefined}
                  >
                    {w.starred ? "★" : "☆"}
                  </button>
                  <button
                    className="word-action-btn"
                    onClick={() =>
                      patch(w.id, { status: w.status === "learned" ? "learning" : "learned" })
                    }
                    title={w.status === "learned" ? "标记为学习中" : "标记为已掌握"}
                  >
                    {w.status === "learned" ? "↩" : "✓"}
                  </button>
                  {w.status === "deleted" ? (
                    <button
                      className="word-action-btn"
                      onClick={() => patch(w.id, { status: "learning" })}
                      title="恢复到词库"
                    >
                      ⟲
                    </button>
                  ) : (
                    <button
                      className="word-action-btn"
                      onClick={() => patch(w.id, { status: "deleted" })}
                      title="移出词库（可在「已移出」里恢复）"
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>

              {w.pos && (
                <span className="duo-badge duo-badge-purple mb-1.5 inline-block">{w.pos}</span>
              )}

              {/* 释义：AI 释义是 Markdown（标题/加粗/列表），与阅读页批注卡同一套渲染 */}
              <div className="text-[14px] text-ink-soft font-medium mb-2">
                <MarkdownText text={normalizeTranslation(w.translation)} />
              </div>

              {/* 上下文原句 + 跳回原文 */}
              {w.contexts.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {w.contexts.map((c) => (
                    <div
                      key={c.id}
                      className="rounded-lg px-3 py-2 text-[13px] leading-relaxed"
                      style={{ background: "var(--duo-surface)" }}
                    >
                      <p className="text-ink-soft italic">&ldquo;{c.sentence}&rdquo;</p>
                      <p className="text-[11px] font-bold text-ink-faint mt-1 flex items-center gap-2">
                        <span>{c.textTitle && `← ${c.textTitle}`}</span>
                        {c.textId && c.paragraphId && (
                          <Link
                            href={`/texts/${c.textId}?p=${c.paragraphId}`}
                            className="text-ink-faint hover:text-[var(--duo-green-dark)] underline underline-offset-2"
                          >
                            跳到原文 →
                          </Link>
                        )}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

/**
 * 「待推送」视图（P33 F5 / spec §8.2）：词库里有草稿卡、还没推到墨墨的词。
 * 草稿只存在 ReadFlow 里，检查 / 修改 / 换一道 / 删除之后，才由用户点推送写进墨墨。
 * 一屏只有一个绿色主按钮：「推送全部」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import CardPreview from "@/components/CardPreview";
import CardEditor from "@/components/CardEditor";
import type { PreviewModel } from "@/lib/cards/render";
import type { CardSpec } from "@/lib/cards/spec";

type PendingCard = { cardId: string; setId: string; seq: number; needsReview: string | null; edited: boolean };
type PendingWord = { wordId: string; lemma: string; displayForm: string; phonetic: string | null; isPhrase: boolean; cards: PendingCard[] };
type PendingText = { textId: string; title: string; words: PendingWord[] };
type PendingData = {
  texts: PendingText[];
  total: number;
  wordCount: number;
  defaults: { deckId: string | null; chapterId: string | null; chapterMode: "fixed" | "per_article" };
  activeJobId: string | null;
  markjiConfigured: boolean;
};
type SetCard = { id: string; status: string; needsReview: string | null; edited: boolean; preview: PreviewModel; spec: CardSpec };
type Job = {
  jobId: string; status: "running" | "paused" | "done" | "error"; done: number; failed: number; total: number;
  error: string | null; failures: { cardId: string; error: string }[];
};

/** 待推送总数；词库左侧筛选栏的「待推送 (N)」用 */
export async function fetchPendingTotal(): Promise<number | null> {
  try {
    const res = await fetch("/api/cards/pending");
    if (!res.ok) return null;
    return ((await res.json()) as PendingData).wordCount;
  } catch {
    return null;
  }
}

export default function PendingCards({
  articleKey,
  focusWordId,
  onTotal,
}: {
  /** 左侧选中的文章（textId）；空 = 全部 */
  articleKey: string;
  focusWordId?: string;
  onTotal: (n: number) => void;
}) {
  const [data, setData] = useState<PendingData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [openWord, setOpenWord] = useState<string | null>(focusWordId ?? null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sets, setSets] = useState<Record<string, SetCard[]>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [cardError, setCardError] = useState<Record<string, string>>({});

  // 推送栏
  const [decks, setDecks] = useState<{ id: string; name: string }[]>([]);
  const [chapters, setChapters] = useState<{ id: string; name: string }[]>([]);
  const [deckId, setDeckId] = useState("");
  const [chapterId, setChapterId] = useState("");
  const [perArticle, setPerArticle] = useState(false);
  const [barError, setBarError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const defaultsApplied = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cards/pending");
      if (!res.ok) throw new Error();
      const d = (await res.json()) as PendingData;
      setData(d);
      onTotal(d.wordCount);
      setLoadError("");
      if (!defaultsApplied.current) {
        defaultsApplied.current = true;
        setPerArticle(d.defaults.chapterMode === "per_article");
        if (d.defaults.deckId) setDeckId(d.defaults.deckId);
        if (d.defaults.chapterId) setChapterId(d.defaults.chapterId);
        if (d.activeJobId) setJobId(d.activeJobId);
      }
    } catch {
      setLoadError("没能加载待推送的卡片，刷新页面再试");
    }
  }, [onTotal]);

  useEffect(() => {
    void load();
  }, [load]);

  // 牌组 / 章节（沿用 /api/markji/decks，token 只在服务端）
  useEffect(() => {
    if (!data?.markjiConfigured) return;
    fetch("/api/markji/decks")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setDecks(d.decks ?? []);
        else setBarError(d.error ?? "读取牌组失败");
      })
      .catch(() => setBarError("读取牌组失败"));
  }, [data?.markjiConfigured]);
  useEffect(() => {
    if (!deckId) {
      setChapters([]);
      return;
    }
    fetch(`/api/markji/decks?deckId=${encodeURIComponent(deckId)}`)
      .then((r) => r.json())
      .then((d) => setChapters(d.ok ? (d.chapters ?? []) : []))
      .catch(() => setChapters([]));
  }, [deckId]);

  // 推送进度：每 1.5 秒一次，结束后刷新列表
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/cards/push/${jobId}`);
        if (!res.ok) return;
        const j = (await res.json()) as Job;
        if (stop) return;
        setJob(j);
        if (j.status !== "running") {
          setJobId(null);
          void load();
          setSets({});
        }
      } catch {
        /* 下一次再查 */
      }
    };
    void tick();
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [jobId, load]);

  const loadSet = useCallback(async (setId: string) => {
    const res = await fetch(`/api/cards/sets/${setId}`);
    if (!res.ok) return;
    const d = await res.json();
    setSets((cur) => ({ ...cur, [setId]: (d.cards as SetCard[]).filter((c) => c.status === "draft") }));
  }, []);

  const texts = useMemo(
    () =>
      (data?.texts ?? [])
        .filter((t) => !articleKey || t.textId === articleKey)
        // 需要人工检查的词放最前面
        .map((t) => ({
          ...t,
          words: [...t.words].sort(
            (a, b) => Number(b.cards.some((c) => c.needsReview)) - Number(a.cards.some((c) => c.needsReview)),
          ),
        })),
    [data, articleKey],
  );
  const allWords = useMemo(() => texts.flatMap((t) => t.words), [texts]);

  // 展开的词：把它各组的卡片取回来
  useEffect(() => {
    const w = allWords.find((x) => x.wordId === openWord);
    if (!w) return;
    for (const setId of new Set(w.cards.map((c) => c.setId))) if (!sets[setId]) void loadSet(setId);
  }, [openWord, allWords, sets, loadSet]);

  const pushWords = allWords.filter((w) => selected.size === 0 || selected.has(w.wordId));
  const pushIds = pushWords.flatMap((w) => w.cards.map((c) => c.cardId));
  const running = job?.status === "running" || (jobId !== null && job === null);

  async function push(ids: string[]) {
    setBarError("");
    if (!deckId) return setBarError("先选择牌组");
    if (!perArticle && !chapterId) return setBarError("先选择章节，或勾选「按文章自动建章节」");
    const res = await fetch("/api/cards/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: ids, deckId, chapterMode: perArticle ? "per_article" : "fixed", ...(perArticle ? {} : { chapterId }) }),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      if (d?.jobId) setJobId(d.jobId);
      return setBarError(d?.error ?? "推送失败");
    }
    setJob(null);
    setJobId(d.jobId);
  }

  async function cardAction(cardId: string, setId: string, kind: "regenerate" | "delete") {
    if (kind === "delete" && !window.confirm("从草稿里删掉这张卡？")) return;
    setBusyCard(cardId);
    setCardError((e) => ({ ...e, [cardId]: "" }));
    try {
      const res = await fetch(kind === "delete" ? `/api/cards/${cardId}` : `/api/cards/${cardId}/regenerate`, {
        method: kind === "delete" ? "DELETE" : "POST",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setCardError((e) => ({ ...e, [cardId]: d?.error ?? "操作失败" }));
        return;
      }
      setSets((cur) => {
        const { [setId]: _gone, ...rest } = cur;
        void _gone;
        return rest;
      });
      await load();
    } finally {
      setBusyCard(null);
    }
  }

  if (loadError) return <p className="st-notice st-notice-err" role="alert">{loadError}</p>;
  if (!data) return <p className="text-sm font-bold text-ink-faint">加载中…</p>;

  return (
    <div className="pc-wrap">
      {/* ---------- 推送栏 ---------- */}
      {!data.markjiConfigured ? (
        <div className="st-notice pc-bar">
          还没有配置墨墨 Token，草稿会先保存在这里。
          <Link href="/settings" className="pc-link">去设置里填写</Link>
        </div>
      ) : (
        <div className="pc-bar">
          <div className="pc-bar-row">
            <label className="pc-field">
              牌组
              <select className="duo-input" value={deckId} onChange={(e) => { setDeckId(e.target.value); setChapterId(""); }}>
                <option value="">选择牌组</option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
            <label className="pc-field">
              章节
              <select className="duo-input" value={chapterId} disabled={perArticle || !deckId} onChange={(e) => setChapterId(e.target.value)}>
                <option value="">{perArticle ? "按文章自动建章节" : "选择章节"}</option>
                {chapters.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="pc-check">
            <input type="checkbox" checked={perArticle} onChange={(e) => setPerArticle(e.target.checked)} />
            按文章自动建章节（每篇文章一个章节，已有同名章节会直接用）
          </label>
          <div className="pc-bar-row">
            <button
              type="button"
              className="duo-btn duo-btn-primary duo-btn-sm"
              disabled={running || pushIds.length === 0}
              onClick={() => void push(pushIds)}
            >
              {selected.size > 0 ? `推送选中的 ${pushWords.length} 个词（${pushIds.length} 张）` : `推送全部（${pushIds.length} 张）`}
            </button>
            <span className="pc-note">墨墨里的卡片删不掉，推送前请先检查。</span>
          </div>
          {barError && <p className="pc-error" role="alert">{barError}</p>}
          {job && (
            <div className="pc-progress" aria-live="polite">
              <div className="duo-progress-wrap">
                <div className="duo-progress">
                  <div className="duo-progress-fill" style={{ width: `${job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 0}%` }} />
                </div>
              </div>
              <p>
                {job.status === "running" ? "正在推送：" : job.status === "done" ? "推送完成：" : "已停下："}
                已推送 {job.done} / 共 {job.total}
                {job.failed > 0 ? `，${job.failed} 张失败` : ""}
              </p>
              {job.error && <p className="pc-error">{job.error}</p>}
              {job.status !== "running" && job.failures.length > 0 && (
                <div>
                  <ul className="pc-failures">
                    {job.failures.map((f) => (
                      <li key={f.cardId}>{f.error}</li>
                    ))}
                  </ul>
                  <button type="button" className="duo-btn-sm duo-btn-white" onClick={() => void push(job.failures.map((f) => f.cardId))}>
                    重试失败的 {job.failures.length} 张
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---------- 词列表 ---------- */}
      {texts.length === 0 ? (
        <div className="duo-empty">
          <div className="duo-empty-icon">🃏</div>
          <p className="text-lg font-bold mb-2">没有待推送的卡片</p>
          <p className="text-sm text-ink-faint">在阅读页点词，查看讲解后点「＋ 做成卡片」</p>
        </div>
      ) : (
        texts.map((t) => (
          <section key={t.textId} className="pc-text">
            <h3 className="pc-text-title">📖 {t.title}</h3>
            <ul>
              {t.words.map((w) => {
                const open = openWord === w.wordId;
                const review = w.cards.some((c) => c.needsReview);
                return (
                  <li key={w.wordId} className={`wl-row${open ? " wl-row-open" : ""}`}>
                    <div className="pc-word-head">
                      <label className="wl-check">
                        <input
                          type="checkbox"
                          checked={selected.has(w.wordId)}
                          onChange={() =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (n.has(w.wordId)) n.delete(w.wordId);
                              else n.add(w.wordId);
                              return n;
                            })
                          }
                          aria-label={`选择 ${w.displayForm}`}
                        />
                        <span />
                      </label>
                      <button type="button" className="pc-word-btn" aria-expanded={open} onClick={() => setOpenWord(open ? null : w.wordId)}>
                        <b>{w.displayForm}</b>
                        <span className="pc-count">{w.cards.length} 张卡</span>
                        {review && <span className="duo-badge duo-badge-orange">需要检查</span>}
                      </button>
                    </div>
                    {open && (
                      <div className="wl-detail">
                        {w.cards.map((c) => c.setId).filter((v, i, a) => a.indexOf(v) === i).map((setId) => {
                          const cards = [...(sets[setId] ?? [])].sort((a, b) => Number(Boolean(b.needsReview)) - Number(Boolean(a.needsReview)));
                          if (!sets[setId]) return <p key={setId} className="text-sm font-bold text-ink-faint">加载卡片…</p>;
                          return cards.map((c) => (
                            <div key={c.id} className="pc-card">
                              {editing === c.id ? (
                                <CardEditor
                                  cardId={c.id}
                                  initial={c.spec}
                                  onCancel={() => setEditing(null)}
                                  onSaved={() => {
                                    setEditing(null);
                                    void loadSet(setId);
                                    void load();
                                  }}
                                />
                              ) : (
                                <>
                                  <CardPreview preview={c.preview} notice={c.needsReview} />
                                  <div className="pc-actions">
                                    <button type="button" className="duo-btn-sm duo-btn-white" onClick={() => setEditing(c.id)}>修改</button>
                                    <button type="button" className="duo-btn-sm duo-btn-white" disabled={busyCard === c.id} onClick={() => void cardAction(c.id, setId, "regenerate")}>
                                      {busyCard === c.id ? "处理中…" : "换一道"}
                                    </button>
                                    <button type="button" className="duo-btn-sm duo-btn-white" disabled={busyCard === c.id} onClick={() => void cardAction(c.id, setId, "delete")}>删除</button>
                                  </div>
                                  {cardError[c.id] && <p className="pc-error" role="alert">{cardError[c.id]}</p>}
                                </>
                              )}
                            </div>
                          ));
                        })}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

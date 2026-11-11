"use client";

import { useCallback, useEffect, useState } from "react";
import { CARD_TYPES, type CardType } from "@/lib/cardgen";

type Deck = { id: string; name: string; card_count?: number; chapter_count?: number };
type Chapter = { id: string; name: string; card_ids?: string[] };

type ExportItem = {
  wordId: string;
  word: string;
  cardType: CardType;
  content: string;
  status: "pending" | "done" | "skipped" | "failed";
  cardId?: string;
  error?: string;
};

type ExportResult = {
  ok: boolean;
  dryRun: boolean;
  summary: { pushed: number; skipped: number; failed: number; invalid: number };
  items: ExportItem[];
  remainingToday?: number;
  wordCount?: number;
  error?: string;
};

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  CARD_TYPES.map((t) => [t.key, t.label]),
);

export default function ExportPanel({
  tokenReady,
  initialDeckId,
  initialChapterId,
  wordIds,
  todayPushed,
  dailyCap,
}: {
  tokenReady: boolean;
  initialDeckId: string;
  initialChapterId: string;
  /** 只导出这些词（词库里勾选的）；接口不再接受「全部」 */
  wordIds: string[];
  todayPushed: number;
  dailyCap: number;
}) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [deckId, setDeckId] = useState(initialDeckId);
  const [chapterId, setChapterId] = useState(initialChapterId);
  const [types, setTypes] = useState<CardType[]>(["qa", "cloze"]);
  const [busy, setBusy] = useState<null | "preview" | "write">(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deckError, setDeckError] = useState<string | null>(null);

  // 牌组列表
  useEffect(() => {
    if (!tokenReady) return;
    fetch("/api/markji/decks")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setDecks(d.decks ?? []);
        else setDeckError(d.error ?? "读取牌组失败");
      })
      .catch(() => setDeckError("读取牌组失败"));
  }, [tokenReady]);

  // 章节列表（换牌组就重查）
  useEffect(() => {
    if (!tokenReady || !deckId) {
      setChapters([]);
      return;
    }
    fetch(`/api/markji/decks?deckId=${encodeURIComponent(deckId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          const list: Chapter[] = d.chapters ?? [];
          setChapters(list);
          // 之前存的章节不属于这个牌组时清掉，避免推错地方
          if (!list.some((c) => c.id === chapterId)) setChapterId(list[0]?.id ?? "");
        } else setDeckError(d.error ?? "读取章节失败");
      })
      .catch(() => setDeckError("读取章节失败"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, tokenReady]);

  const toggleType = useCallback((t: CardType) => {
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }, []);

  const wordCount = wordIds.length;

  async function run(dryRun: boolean) {
    setError(null);
    setResult(null);

    if (types.length === 0) {
      setError("至少选择一种卡片类型");
      return;
    }
    if (!dryRun && (!deckId || !chapterId)) {
      setError("请先选择牌组和章节");
      return;
    }
    if (!dryRun) {
      const est = wordCount * types.length;
      const ok = window.confirm(
        `即将向墨墨写入最多 ${est} 张卡片（${wordCount} 个词 × ${types.length} 种类型）。\n\n` +
          `墨墨开放 API 没有删除接口，写错的卡片只能在 App 里手动删除。\n` +
          `已在目标牌组推过的卡片会自动跳过。\n\n确定继续？`,
      );
      if (!ok) return;
    }

    setBusy(dryRun ? "preview" : "write");
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId, chapterId, types, wordIds, dryRun }),
      });
      const data: ExportResult = await res.json();
      if (!res.ok && data.error) setError(data.error);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {!tokenReady && (
        <div
          className="duo-card p-5"
          style={{ background: "var(--duo-orange-soft)", borderColor: "var(--duo-orange)" }}
        >
          <p className="text-base font-extrabold mb-1">还没配置墨墨令牌</p>
          <p className="text-sm font-semibold text-ink-soft leading-relaxed">
            点右上角头像 → <b>设置</b> → 墨墨记单词，填入你的开放 API Token，保存即可生效（不用重启）。
            令牌获取：墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API。
          </p>
        </div>
      )}

      {/* 目标位置 */}
      <div className="duo-card p-6">
        <div className="duo-section-title mb-4">
          <span style={{ color: "var(--duo-blue)" }}>🎯</span>
          推送到哪里
        </div>

        <p className="text-sm font-semibold text-ink-faint mb-4 leading-relaxed">
          墨墨开放 API 只能写卡片，<b>不能建牌组、也不能建章节</b>。所以请先在 App
          或网页端把牌组和章节建好，这里只负责往里写。
        </p>

        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-bold text-ink-soft block mb-2">牌组</span>
            <select
              className="duo-input"
              value={deckId}
              disabled={!tokenReady || decks.length === 0}
              onChange={(e) => setDeckId(e.target.value)}
            >
              <option value="">{decks.length ? "选择牌组…" : "（还没有可选牌组）"}</option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {typeof d.card_count === "number" ? ` · ${d.card_count} 张` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-bold text-ink-soft block mb-2">章节</span>
            <select
              className="duo-input"
              value={chapterId}
              disabled={!deckId || chapters.length === 0}
              onChange={(e) => setChapterId(e.target.value)}
            >
              <option value="">
                {!deckId ? "先选牌组" : chapters.length ? "选择章节…" : "（这个牌组下还没章节）"}
              </option>
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {Array.isArray(c.card_ids) ? ` · ${c.card_ids.length} 张` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {deckError && (
          <p className="text-sm font-bold mt-3" style={{ color: "var(--duo-red)" }}>
            {deckError}
          </p>
        )}
      </div>

      {/* 卡片类型 */}
      <div className="duo-card p-6">
        <div className="duo-section-title mb-4">
          <span style={{ color: "var(--duo-purple)" }}>🃏</span>
          生成哪些卡片
        </div>

        <div className="space-y-3">
          {CARD_TYPES.map((t) => {
            const on = types.includes(t.key);
            return (
              <button
                key={t.key}
                onClick={() => toggleType(t.key)}
                className="w-full text-left rounded-xl px-4 py-3 transition-colors"
                style={{
                  background: on ? "var(--duo-green-soft)" : "var(--duo-surface)",
                  border: `2px solid ${on ? "var(--duo-green)" : "var(--duo-border)"}`,
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex items-center justify-center w-5 h-5 rounded-md text-xs font-bold text-white shrink-0"
                    style={{ background: on ? "var(--duo-green)" : "var(--duo-ink-faint)" }}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span className="text-sm font-extrabold">{t.label}</span>
                </div>
                <p className="text-xs font-semibold text-ink-faint mt-1 ml-7">{t.hint}</p>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 text-xs font-bold text-ink-faint mt-4">
          <span className="duo-badge duo-badge-blue">选中 {wordCount} 个词</span>
          <span className="duo-badge duo-badge-orange">
            今日已推 {todayPushed} / {dailyCap}
          </span>
        </div>
      </div>

      {/* 操作 */}
      <div className="flex flex-wrap gap-3">
        <button
          className="duo-btn duo-btn-white"
          disabled={busy !== null || wordCount === 0}
          onClick={() => run(true)}
        >
          {busy === "preview" ? "生成预览中…" : "👀 预览卡片"}
        </button>
        <button
          className="duo-btn duo-btn-primary"
          disabled={busy !== null || wordCount === 0 || !tokenReady}
          onClick={() => run(false)}
        >
          {busy === "write" ? "写入中…" : "🚀 写入墨墨"}
        </button>
      </div>

      {error && (
        <div
          className="duo-card p-4"
          style={{ background: "var(--duo-red-soft)", borderColor: "var(--duo-red)" }}
        >
          <p className="text-sm font-bold" style={{ color: "var(--rf-danger-text)" }}>
            {error}
          </p>
        </div>
      )}

      {result && <ResultView result={result} />}
    </div>
  );
}

function ResultView({ result }: { result: ExportResult }) {
  const { summary, items, dryRun } = result;
  const previews = items.filter((i) => i.content);

  return (
    <div className="duo-card p-6">
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <span className="duo-section-title">
          {dryRun ? "预览" : "写入结果"}
        </span>
        {!dryRun && (
          <>
            <span className="duo-badge duo-badge-green">成功 {summary.pushed}</span>
            <span className="duo-badge duo-badge-blue">跳过 {summary.skipped}</span>
            {summary.failed > 0 && (
              <span className="duo-badge" style={{ background: "var(--duo-red-soft)", color: "var(--rf-danger-text)" }}>
                失败 {summary.failed}
              </span>
            )}
          </>
        )}
        {dryRun && <span className="duo-badge duo-badge-blue">共 {items.length} 张待生成</span>}
      </div>

      {dryRun && (
        <p className="text-sm font-semibold text-ink-faint mb-4 leading-relaxed">
          下面是真正会发送给墨墨的原始语法。换行、<code className="font-mono">---</code>
          答案线、<code className="font-mono">[F#1#…]</code> 挖空都是语法的一部分。
          确认无误再点「写入墨墨」。
        </p>
      )}

      <div className="space-y-4">
        {previews.map((it, i) => (
          <div key={`${it.wordId}-${it.cardType}-${i}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-extrabold">{it.word}</span>
              <span className="duo-badge duo-badge-green">{TYPE_LABEL[it.cardType] ?? it.cardType}</span>
              {it.status === "failed" && (
                <span className="duo-badge" style={{ background: "var(--duo-red-soft)", color: "var(--rf-danger-text)" }}>
                  未通过
                </span>
              )}
              {it.cardId && (
                <span className="text-xs font-mono text-ink-faint">{it.cardId}</span>
              )}
            </div>
            <pre
              className="text-xs leading-relaxed font-mono whitespace-pre-wrap break-words rounded-xl p-4"
              style={{ background: "var(--duo-surface)", border: "1px solid var(--duo-border)" }}
            >
              {it.content}
            </pre>
            {it.error && (
              <p className="text-xs font-bold mt-1" style={{ color: "var(--duo-red)" }}>
                {it.error}
              </p>
            )}
          </div>
        ))}
      </div>

      {!dryRun && summary.pushed > 0 && (
        <p className="text-sm font-semibold text-ink-faint mt-5">
          卡片已经写进墨墨了。打开 App 到对应章节就能看到——不想要的话只能在 App 里手删。
        </p>
      )}
    </div>
  );
}

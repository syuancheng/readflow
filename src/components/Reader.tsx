"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildAnchor, tokenize, type Anchor } from "@/lib/tokenize";
import { normalizePhonetic, normalizeTranslation } from "@/lib/text";

type Para = { id: string; idx: number; content: string };
export type ReaderPara = Para;

type Pick = {
  paragraphId: string;
  paragraphIdx: number;
  anchor: Anchor;
  x: number;
  y: number;
  /** 来源：点词 or 拖选。点词才支持「再点一次收起」 */
  source: "word" | "select";
  /** 点词自动入库时，本次是新建词条 —— 收起批注时撤销（delete-on-deselect） */
  justSaved?: boolean;
};

/** 把 DOM 里的 (node, offset) 换算成段落内的字符偏移 */
function offsetIn(container: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(container);
  r.setEnd(node, offset);
  return r.toString().length;
}

function paraOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  return el?.closest<HTMLElement>("[data-pid]") ?? null;
}

/**
 * 把选区的两端吸附到词边界。
 * 用户按下/松开鼠标的位置经常落在词的中间（比如从 "This" 的 T 和 h 之间开始拖），
 * 字符级选区会变成 "is post…" 这样的半截词。这里把：
 *   - 起点：落在某词内部（offset > 0）→ 扩展到该词开头
 *   - 终点：落在某词内部（offset < 词长）→ 扩展到该词结尾
 * 标点和空白不在 .w span 里，保持原样不吸附。
 * 返回新 Range 并把视觉选区一并更新，保证高亮和弹层内容一致。
 */
function snapRangeToWords(range: Range): Range {
  const r = range.cloneRange();

  const startEl =
    r.startContainer.nodeType === 3 ? r.startContainer.parentElement : (r.startContainer as HTMLElement);
  const startWord = startEl?.closest<HTMLElement>(".w");
  if (
    startWord &&
    r.startContainer.nodeType === 3 &&
    r.startOffset > 0 &&
    r.startOffset < (r.startContainer as Text).length
  ) {
    r.setStartBefore(startWord);
  }

  const endEl =
    r.endContainer.nodeType === 3 ? r.endContainer.parentElement : (r.endContainer as HTMLElement);
  const endWord = endEl?.closest<HTMLElement>(".w");
  if (endWord && r.endContainer.nodeType === 3 && r.endOffset > 0 && r.endOffset < (r.endContainer as Text).length) {
    r.setEndAfter(endWord);
  }

  if (!r.collapsed) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
  return r;
}

/** 从 anchor 重建整句话作为 context */
function sentenceOf(anchor: Anchor): string {
  const prefix = anchor.prefix || "";
  const suffix = anchor.suffix || "";
  // prefix 是段内前文，取最后一个句子边界后的部分
  const prefixSent = prefix.replace(/^.*[.!?]\s*/, "");
  const suffixSent = suffix.replace(/\s*[.!?].*$/, "");
  return `${prefixSent}${anchor.quote}${suffixSent}`.trim() || anchor.quote;
}

const Para = memo(function Para({ p, savedLemmas }: { p: Para; savedLemmas: Set<string> }) {
  const tokens = useMemo(() => tokenize(p.content), [p.content]);
  return (
    <p data-pid={p.id} data-idx={p.idx}>
      {tokens.map((t, i) =>
        t.word ? (
          <span
            key={i}
            className={`w${savedLemmas.has(t.text.toLowerCase()) ? " w-saved" : ""}`}
            data-s={t.start}
            data-e={t.end}
          >
            {t.text}
          </span>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </p>
  );
});

export type SavedWordInfo = {
  id: string;
  lemma: string;
  displayForm: string;
  translation: string;
  status: string; // learning | learned | deleted
  starred: number;
  /** 本次点击新建的词条；用于「收起即撤销」 */
  created?: boolean;
};

function buildSavedMap(words: SavedWordInfo[]): Map<string, SavedWordInfo> {
  const map = new Map<string, SavedWordInfo>();
  for (const w of words) {
    // displayForm 和 lemma 都作为键：点 "rained" 也能命中已存的 "rain"
    map.set(w.displayForm.toLowerCase(), w);
    map.set(w.lemma.toLowerCase(), w);
  }
  return map;
}

/** 正文里当前被批注的锚点高亮（飞书/腾讯文档式） */
function markActiveAnchor(els: Iterable<Element>) {
  document.querySelectorAll(".w-anchor").forEach((el) => el.classList.remove("w-anchor"));
  for (const el of els) el.classList.add("w-anchor");
}

export default function Reader({
  textId,
  paragraphs,
  savedWords,
  focusParaId,
}: {
  textId: string;
  paragraphs: Para[];
  savedWords: SavedWordInfo[];
  focusParaId?: string;
}) {
  const [pick, setPick] = useState<Pick | null>(null);
  const [floats, setFloats] = useState<{ id: number; x: number; y: number; text: string }[]>([]);
  const [autoSave, setAutoSave] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 已收词表（含状态），键为小写 displayForm / lemma
  const [savedMap, setSavedMap] = useState<Map<string, SavedWordInfo>>(() =>
    buildSavedMap(savedWords),
  );

  useEffect(() => {
    setAutoSave(localStorage.getItem("readflow.autoSave") !== "0");
  }, []);

  function toggleAutoSave() {
    setAutoSave((v) => {
      const next = !v;
      localStorage.setItem("readflow.autoSave", next ? "1" : "0");
      return next;
    });
  }

  /** 关闭右侧批注：清空选区 + 去掉正文锚点高亮 */
  const close = useCallback(() => {
    setPick(null);
    markActiveAnchor([]);
    window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  // 词库"跳到原文"入口：滚动到目标段落并短暂高亮
  useEffect(() => {
    if (!focusParaId) return;
    const el = document.querySelector(`[data-pid="${focusParaId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("para-flash");
    const t = setTimeout(() => el.classList.remove("para-flash"), 2600);
    return () => clearTimeout(t);
  }, [focusParaId]);

  // 用于高亮的已收词集合
  const savedSet = useMemo(() => {
    const s = new Set<string>();
    for (const w of savedMap.values()) {
      if (w.status === "deleted") continue;
      s.add(w.displayForm.toLowerCase());
      s.add(w.lemma.toLowerCase());
    }
    return s;
  }, [savedMap]);

  function onClick(e: React.MouseEvent) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;

    const wordEl = (e.target as HTMLElement).closest<HTMLElement>(".w");
    if (!wordEl) {
      close();
      return;
    }
    const pEl = wordEl.closest<HTMLElement>("[data-pid]");
    if (!pEl) return;

    const pid = pEl.dataset.pid!;
    const p = paragraphs.find((x) => x.id === pid);
    if (!p) return;

    const s = Number(wordEl.dataset.s);
    const en = Number(wordEl.dataset.e);
    const rect = wordEl.getBoundingClientRect();
    const displayForm = wordEl.textContent ?? "";
    const key = displayForm.toLowerCase();

    // 再点同一个词 = 收起批注（本次自动新建的词随之撤销，delete-on-deselect）
    if (pick && pick.source === "word" && pick.anchor.quote.toLowerCase() === key) {
      const victim = pick.justSaved ? savedMap.get(key) : null;
      close();
      if (victim) void unsaveWord(victim, key);
      return;
    }

    const pickData: Pick = {
      paragraphId: pid,
      paragraphIdx: p.idx,
      anchor: buildAnchor(p.content, s, en),
      x: rect.left + rect.width / 2,
      y: rect.bottom,
      source: "word",
    };
    markActiveAnchor([wordEl]);
    setPick(pickData);

    // 已收过的词：右栏直接展示已存释义，不再请求
    const saved = savedMap.get(key) ?? null;
    if (saved && saved.status !== "deleted") return;
    if (!autoSave) return;

    // 自动收词：落库后回填 justSaved（收起批注时可撤销）
    void saveWord(pickData).then((info) => {
      setPick((cur) =>
        cur && cur.source === "word" && cur.anchor.quote.toLowerCase() === key
          ? { ...cur, justSaved: info?.created === true }
          : cur,
      );
    });
  }

  function onMouseUp(e: React.MouseEvent) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    // 先把两端吸附到词边界（起点落在词中间时扩展到整词），再走判定
    const range = snapRangeToWords(sel.getRangeAt(0));
    if (range.collapsed) return;

    const pEl = paraOf(range.commonAncestorContainer);
    if (!pEl) return;

    const pid = pEl.dataset.pid!;
    const p = paragraphs.find((x) => x.id === pid);
    if (!p) return;

    if (paraOf(range.startContainer) !== pEl || paraOf(range.endContainer) !== pEl) return;

    const start = offsetIn(pEl, range.startContainer, range.startOffset);
    const end = offsetIn(pEl, range.endContainer, range.endOffset);
    if (end <= start) return;

    // 拖选：批注卡直接进右栏（不再用鼠标旁浮层）
    const anchors = [...pEl.querySelectorAll<HTMLElement>(".w")].filter((el) => {
      const s = Number(el.dataset.s);
      const en = Number(el.dataset.e);
      return en > start && s < end;
    });
    markActiveAnchor(anchors);
    setPick({
      paragraphId: pid,
      paragraphIdx: p.idx,
      anchor: buildAnchor(p.content, start, end),
      x: e.clientX,
      y: e.clientY,
      source: "select",
    });
  }

  function celebrate(x: number, y: number, label: string) {
    const id = Date.now() + Math.random();
    setFloats((f) => [...f, { id, x, y, text: label }]);
    setTimeout(() => setFloats((f) => f.filter((i) => i.id !== id)), 1200);
  }

  /** 收词落库，返回落库后的词条（供气泡与高亮使用） */
  async function saveWord(pickData: Pick, aiGloss?: string): Promise<SavedWordInfo | null> {
    const { anchor, paragraphId } = pickData;
    try {
      const res = await fetch("/api/words", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          word: anchor.quote,
          textId,
          paragraphId,
          start: anchor.start,
          end: anchor.end,
          quote: anchor.quote,
          prefix: anchor.prefix || "",
          suffix: anchor.suffix || "",
          aiGloss,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const info: SavedWordInfo = {
        id: data.wordId,
        lemma: data.lemma ?? "",
        displayForm: data.displayForm ?? anchor.quote,
        translation: data.translation ?? "",
        status: data.status ?? "learning",
        starred: data.starred ?? 0,
        created: data.created === true,
      };
      setSavedMap((prev) => {
        const next = new Map(prev);
        next.set(info.displayForm.toLowerCase(), info);
        if (info.lemma) next.set(info.lemma.toLowerCase(), info);
        return next;
      });
      celebrate(pickData.x, pickData.y - 20, "+1 词");
      return info;
    } catch {
      return null;
    }
  }

  /**
   * 撤销本次自动收词（Readlang 的 delete-on-deselect）。
   * 用真删除而不是软删除：这个词是用户「顺手点错」收进来的，
   * 还没经过任何复习或导出，留一条「已移出」的垃圾记录没有意义。
   */
  async function unsaveWord(info: SavedWordInfo, key: string) {
    try {
      const res = await fetch(`/api/words/${info.id}`, { method: "DELETE" });
      if (!res.ok) return;
    } catch {
      return;
    }
    setSavedMap((prev) => {
      const next = new Map(prev);
      next.delete(key);
      if (info.lemma) next.delete(info.lemma.toLowerCase());
      return next;
    });
  }

  /** 移出词库（软删除，可恢复；保留 exports 记录保证墨墨幂等） */
  async function removeWord(id: string) {
    try {
      await fetch(`/api/words/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "deleted" }),
      });
      setSavedMap((prev) => {
        const next = new Map(prev);
        for (const [k, v] of next) {
          if (v.id === id) next.set(k, { ...v, status: "deleted" });
        }
        return next;
      });
    } catch {
      /* 静默失败 */
    }
  }

  return (
    <div className="reader-split">
      {/* 左栏（61.8%）：正文 */}
      <div className="reader-main">
        <div className="duo-card reader-article-card">
          <div className="reading-body" ref={bodyRef} onClick={onClick} onMouseUp={onMouseUp}>
            {paragraphs.map((p) => (
              <Para key={p.id} p={p} savedLemmas={savedSet} />
            ))}
          </div>
        </div>
      </div>

      {/* 右栏（38.2%）：飞书/腾讯文档式批注栏，滚动时吸附在顶栏下方 */}
      <aside className="reader-aside">
        <div className="reader-aside-head">
          <p className="reader-aside-title">批注</p>
          <button
            className="autosave-pill"
            onClick={toggleAutoSave}
            title="开启后，点词会自动收进词库；关闭则只看释义，手动点 + 收词"
          >
            <span
              className="autosave-dot"
              style={{ background: autoSave ? "var(--duo-green)" : "var(--duo-ink-faint)" }}
            />
            自动收词 {autoSave ? "开" : "关"}
          </button>
        </div>

        {pick ? (
          <PickCard
            key={`${pick.paragraphId}:${pick.anchor.start}:${pick.anchor.end}:${pick.source}`}
            pick={pick}
            saved={savedMap.get(pick.anchor.quote.toLowerCase()) ?? null}
            onClose={close}
            onSave={(aiGloss?: string) => void saveWord(pick, aiGloss)}
            onDelete={() => {
              const info = savedMap.get(pick.anchor.quote.toLowerCase());
              if (info) void removeWord(info.id);
            }}
            onUndo={() => {
              const info = savedMap.get(pick.anchor.quote.toLowerCase());
              close();
              if (info) void unsaveWord(info, pick.anchor.quote.toLowerCase());
            }}
          />
        ) : (
          <div className="reader-aside-empty">
            <p className="text-[16px] mb-1.5">📝</p>
            <p className="text-[14px] font-bold text-ink-soft">还没有批注</p>
            <p className="text-[13px] text-ink-faint mt-1 leading-relaxed">
              点击文章中的单词，或拖选一句话，
              <br />
              释义和 AI 解释会显示在这里
            </p>
          </div>
        )}
      </aside>

      {floats.map((f) => (
        <div key={f.id} className="duo-float-up" style={{ left: f.x, top: f.y }}>
          {f.text}
        </div>
      ))}
    </div>
  );
}

// ====== PickCard：批注卡（右栏常驻，三层递进释义）======

type DictResult = {
  entry: {
    word: string;
    phonetic: string | null;
    translation: string | null;
    definition: string | null;
    pos: string | null;
    collins: number | null;
  } | null;
  originalForm: string;
  lemmaForm: string;
};

/** 浏览器自带 TTS 朗读，零成本、离线可用 */
function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 0.95;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

function PickCard({
  pick,
  saved,
  onClose,
  onSave,
  onDelete,
  onUndo,
}: {
  pick: Pick;
  saved: SavedWordInfo | null;
  onClose: () => void;
  onSave: (aiGloss?: string) => void;
  onDelete: () => void;
  /** 撤销本次自动收词（仅本次新建的词条会出现） */
  onUndo: () => void;
}) {
  const { anchor, paragraphIdx } = pick;
  // 标题字号随内容长度收缩：单词大字，短语中字，整句小字并限行
  const quote = anchor.quote.trim();
  const titleSize = quote.length > 60 ? 15 : quote.length > 28 ? 16 : quote.length > 14 ? 18 : 20;

  // 词典查询
  const [dict, setDict] = useState<DictResult | null>(null);
  const [dictLoading, setDictLoading] = useState(true);

  // AI 释义
  const [aiText, setAiText] = useState("");
  const [aiStatus, setAiStatus] = useState<"idle" | "loading" | "streaming" | "done" | "error">("idle");
  const [showAskInput, setShowAskInput] = useState(false);
  const [askPrompt, setAskPrompt] = useState("");

  // 是短语（含空格）还是单词
  const isPhrase = /\s/.test(anchor.quote.trim());

  // 弹层打开时自动查词典
  useEffect(() => {
    setDict(null);
    setDictLoading(true);
    setAiText("");
    setAiStatus("idle");
    setShowAskInput(false);
    setAskPrompt("");

    fetch(`/api/dict?word=${encodeURIComponent(anchor.quote)}`)
      .then((r) => r.json())
      .then((data) => {
        setDict(data);
        setDictLoading(false);
      })
      .catch(() => setDictLoading(false));
  }, [anchor.quote]);

  /** 触发 AI 释义（流式） */
  async function triggerAI(prompt?: string) {
    setAiStatus("loading");
    setAiText("");

    const context = sentenceOf(anchor);
    const params = new URLSearchParams({
      word: anchor.quote,
      context,
      language: "en",
      monolingual: "false",
    });
    if (prompt) params.set("prompt", prompt);

    try {
      const res = await fetch(`/api/explain?${params}`);
      if (!res.ok) throw new Error("请求失败");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("无法读取流");

      setAiStatus("streaming");
      const decoder = new TextDecoder();
      let text = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setAiText(text);
      }

      setAiStatus("done");
    } catch (err) {
      setAiText(`[Error: ${err instanceof Error ? err.message : "AI 释义失败"}]`);
      setAiStatus("error");
    }
  }

  return (
    <div
      className="reader-note duo-anim-pop"
      onClick={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {/* 标题行：词 + 音标 + 发音，右侧收词/关闭 */}
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <p
            className="font-extrabold leading-snug break-words text-ink"
            style={{
              fontSize: titleSize,
              display: "-webkit-box",
              WebkitLineClamp: 4,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
            title={quote}
          >
            {quote}
          </p>
          <div className="flex items-center gap-2 mt-1">
            {dict?.entry?.phonetic && (
              <button
                className="text-[13px] font-mono text-ink-soft hover:text-ink cursor-pointer leading-none"
                onClick={() => speak(quote)}
                title="点击朗读"
              >
                /{normalizePhonetic(dict.entry.phonetic)}/
              </button>
            )}
            {canSpeak && (
              <button
                className="duo-speak-btn"
                onClick={() => speak(quote)}
                aria-label="发音"
                title="发音"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M11 5 6.5 8.5H3v7h3.5L11 19V5Z" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  <path d="M18.5 6a8.5 8.5 0 0 1 0 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* 收词按钮：已收显示 ✓（点击移出词库），未收显示 + */}
          {saved && saved.status !== "deleted" ? (
            <button
              className="duo-icon-btn duo-icon-btn-sm duo-icon-btn-saved"
              onClick={onDelete}
              title="已在词库 · 点击移出"
              aria-label="已在词库，点击移出"
            >
              ✓
            </button>
          ) : (
            <button
              className="duo-icon-btn duo-icon-btn-sm"
              onClick={() => onSave(aiStatus === "done" ? aiText : undefined)}
              title="收进词库"
              aria-label="收进词库"
            >
              +
            </button>
          )}
          <button
            onClick={onClose}
            className="text-ink-faint hover:text-ink-soft text-[15px] leading-none px-0.5 font-bold"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      </div>

      {/* 本次自动收词 → 显式撤销入口（delete-on-deselect 之外的可见途径） */}
      {pick.justSaved && (
        <button className="rf-undo" onClick={onUndo} title="删除这条刚收进的词">
          ↩ 已自动收进词库 · 撤销
        </button>
      )}

      {/* 词典释义：无框平铺 */}
      {dictLoading ? (
        <p className="text-[14px] font-bold text-ink-faint mt-4">查词典中…</p>
      ) : dict?.entry ? (
        <DictView entry={dict.entry} lemmaForm={dict.lemmaForm} originalForm={dict.originalForm} />
      ) : (
        <p className="text-[13px] font-bold text-ink-faint mt-4">
          {isPhrase ? "短语不在词典中" : "词典未收录"} · 可用 AI 解释
        </p>
      )}

      {/* AI 释义：小按钮入口 */}
      {aiStatus === "idle" && (
        <button className="rf-ai-mini mt-3" onClick={() => triggerAI()}>
          ✨ AI 释义
        </button>
      )}

      {/* AI 内容：平铺展示 */}
      {aiStatus !== "idle" && (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="duo-badge duo-badge-green">AI 释义</span>
            {aiStatus === "loading" && (
              <span className="text-[12px] font-bold text-ink-faint">正在思考…</span>
            )}
            {aiStatus === "streaming" && (
              <span className="text-[12px] font-bold" style={{ color: "var(--duo-green-dark)" }}>
                生成中…
              </span>
            )}
            {aiStatus === "done" && !showAskInput && (
              <button className="rf-ask-mini" onClick={() => setShowAskInput(true)}>
                追问
              </button>
            )}
          </div>
          <div className="rf-md text-[14px] leading-relaxed text-ink">
            <MarkdownText text={aiText} />
            {aiStatus === "streaming" && (
              <span
                className="inline-block w-1.5 h-4 ml-0.5 align-middle animate-pulse"
                style={{ background: "var(--duo-green)" }}
              />
            )}
          </div>
        </div>
      )}

      {showAskInput && (
        <div className="mt-3">
          <input
            className="duo-input mb-2 !text-[14px]"
            placeholder="例如：这个词还有别的用法吗？"
            value={askPrompt}
            onChange={(e) => setAskPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && askPrompt.trim()) {
                triggerAI(askPrompt.trim());
                setShowAskInput(false);
              }
            }}
          />
          <div className="flex gap-2">
            <button
              className="rf-ai-mini"
              onClick={() => {
                if (askPrompt.trim()) {
                  triggerAI(askPrompt.trim());
                  setShowAskInput(false);
                }
              }}
            >
              提问
            </button>
            <button className="rf-ai-mini" onClick={() => setShowAskInput(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 锚点信息 */}
      <details className="mt-4">
        <summary className="text-[11px] font-bold uppercase tracking-wide text-ink-faint cursor-pointer">
          上下文锚点
        </summary>
        <div className="space-y-1.5 mt-2">
          <Row label="前文" value={anchor.prefix || "（段首）"} />
          <Row label="后文" value={anchor.suffix || "（段尾）"} />
          <Row label="位置" value={`第 ${paragraphIdx + 1} 段 · ${anchor.start}–${anchor.end}`} />
        </div>
      </details>
    </div>
  );
}

/** 词典释义展示 */
function DictView({
  entry,
  lemmaForm,
  originalForm,
}: {
  entry: DictResult["entry"];
  lemmaForm: string;
  originalForm: string;
}) {
  if (!entry) return null;

  const showLemma = lemmaForm.toLowerCase() !== originalForm.toLowerCase();

  return (
    <div className="mt-3">
      {showLemma && (
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="duo-badge duo-badge-green">{lemmaForm}</span>
          <span className="text-[12px] font-bold text-ink-faint">← 原形</span>
        </div>
      )}

      {entry.translation && (
        <p className="text-[15px] font-medium leading-relaxed text-ink whitespace-pre-line">
          {normalizeTranslation(entry.translation)}
        </p>
      )}

      {entry.definition && entry.definition.length > 0 && (
        <details className="mt-2">
          <summary className="text-[12px] font-bold text-ink-faint cursor-pointer">
            英文释义
          </summary>
          <p className="text-[13px] leading-relaxed text-ink-soft mt-1.5 whitespace-pre-line">
            {normalizeTranslation(entry.definition)}
          </p>
        </details>
      )}

      {entry.collins && entry.collins > 0 && (
        <div className="flex items-center gap-1 mt-2">
          <span className="text-[11px] font-bold text-ink-faint">柯林斯</span>
          {"★".repeat(Math.min(entry.collins, 5)).split("").map((s, i) => (
            <span key={i} className="text-[12px]" style={{ color: "var(--duo-orange)" }}>{s}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-[12px] leading-relaxed">
      <span className="text-ink-faint shrink-0 w-9 font-bold">{label}</span>
      <span className="text-ink-soft font-mono break-all">{value}</span>
    </div>
  );
}

// ====== 轻量 Markdown 渲染（AI 释义用）======
// 只覆盖 AI 输出常用语法：# 标题 / **加粗** / *斜体* / `行内代码` / 列表 / 引用。
// 解析为 React 元素而非 dangerouslySetInnerHTML，天然免疫 XSS。
// 流式输出时每帧整体重解析，AI 释义篇幅短，无性能问题。

function renderMdInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const t = m[0];
    const key = `md-${i++}`;
    if (t.startsWith("**")) nodes.push(<strong key={key} className="font-bold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) nodes.push(<code key={key} className="rf-md-code">{t.slice(1, -1)}</code>);
    else nodes.push(<em key={key}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function MarkdownText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] | null = null;

  const flush = () => {
    if (list) {
      const items = list.items;
      const ordered = list.ordered;
      blocks.push(
        ordered ? (
          <ol key={`b-${blocks.length}`} className="rf-md-list rf-md-ol">
            {items.map((it, i) => (
              <li key={i}>{renderMdInline(it)}</li>
            ))}
          </ol>
        ) : (
          <ul key={`b-${blocks.length}`} className="rf-md-list rf-md-ul">
            {items.map((it, i) => (
              <li key={i}>{renderMdInline(it)}</li>
            ))}
          </ul>
        ),
      );
      list = null;
    }
    if (quote) {
      const qs = quote;
      blocks.push(
        <blockquote key={`b-${blocks.length}`} className="rf-md-quote">
          {qs.map((q, i) => (
            <p key={i}>{renderMdInline(q)}</p>
          ))}
        </blockquote>,
      );
      quote = null;
    }
  };

  for (const raw of text.split("\n")) {
    const t = raw.trim();
    const h = t.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      flush();
      blocks.push(
        <p key={`b-${blocks.length}`} className="rf-md-h">
          {renderMdInline(h[1])}
        </p>,
      );
    } else if (/^[-*]\s+/.test(t)) {
      if (quote) flush();
      if (!list || list.ordered) {
        flush();
        list = { ordered: false, items: [] };
      }
      list.items.push(t.replace(/^[-*]\s+/, ""));
    } else if (/^\d+[.、)]\s*/.test(t)) {
      if (quote) flush();
      if (!list || !list.ordered) {
        flush();
        list = { ordered: true, items: [] };
      }
      list.items.push(t.replace(/^\d+[.、)]\s*/, ""));
    } else if (t.startsWith(">")) {
      if (list) flush();
      if (!quote) quote = [];
      quote.push(t.replace(/^>\s?/, ""));
    } else if (!t) {
      flush();
    } else {
      flush();
      blocks.push(
        <p key={`b-${blocks.length}`} className="rf-md-p">
          {renderMdInline(t)}
        </p>,
      );
    }
  }
  flush();

  return <>{blocks}</>;
}

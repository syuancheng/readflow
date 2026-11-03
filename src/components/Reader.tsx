"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export default function Reader({
  textId,
  paragraphs,
  savedLemmas,
  onCollect,
}: {
  textId: string;
  paragraphs: Para[];
  savedLemmas: Set<string>;
  onCollect?: () => void;
}) {
  const [pick, setPick] = useState<Pick | null>(null);
  const [floats, setFloats] = useState<{ id: number; x: number; y: number; text: string }[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 本地维护已收词集合的副本，收词后即时高亮（不用刷新页面）
  const [savedSet, setSavedSet] = useState(savedLemmas);

  const close = useCallback(() => {
    setPick(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  function onClick(e: React.MouseEvent) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;

    const wordEl = (e.target as HTMLElement).closest<HTMLElement>(".w");
    if (!wordEl) {
      setPick(null);
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

    setPick((prev) => {
      if (prev && prev.paragraphId === pid && prev.anchor.start === s && prev.anchor.end === en) {
        return null;
      }
      return {
        paragraphId: pid,
        paragraphIdx: p.idx,
        anchor: buildAnchor(p.content, s, en),
        x: rect.left + rect.width / 2,
        y: rect.bottom,
      };
    });
  }

  function onMouseUp(e: React.MouseEvent) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const pEl = paraOf(range.commonAncestorContainer);
    if (!pEl) return;

    const pid = pEl.dataset.pid!;
    const p = paragraphs.find((x) => x.id === pid);
    if (!p) return;

    if (paraOf(range.startContainer) !== pEl || paraOf(range.endContainer) !== pEl) return;

    const start = offsetIn(pEl, range.startContainer, range.startOffset);
    const end = offsetIn(pEl, range.endContainer, range.endOffset);
    if (end <= start) return;

    // 定位用「鼠标落点」而不是选区矩形：整段/整句的选区可能比视口还高，
    // 用选区 bottom 定位会把弹层甩到屏幕外。落点永远在当前视口里。
    setPick({
      paragraphId: pid,
      paragraphIdx: p.idx,
      anchor: buildAnchor(p.content, start, end),
      x: e.clientX,
      y: e.clientY,
    });
  }

  function celebrate(x: number, y: number, label: string) {
    const id = Date.now() + Math.random();
    setFloats((f) => [...f, { id, x, y, text: label }]);
    onCollect?.();
    setTimeout(() => setFloats((f) => f.filter((i) => i.id !== id)), 1200);
  }

  /** 收词落库 */
  async function saveWord(pickData: Pick, aiGloss?: string) {
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
      if (!res.ok) return;
      const data = await res.json();
      // 即时高亮：把 lemma 和 displayForm 都加入 savedSet
      setSavedSet((prev) => {
        const next = new Set(prev);
        if (data.lemma) next.add(data.lemma.toLowerCase());
        if (data.displayForm) next.add(data.displayForm.toLowerCase());
        return next;
      });
      celebrate(pickData.x, pickData.y - 20, "+1 词");
    } catch {
      // 静默失败，不阻断阅读
    }
  }

  return (
    <div className="reading-body" ref={bodyRef} onClick={onClick} onMouseUp={onMouseUp}>
      {paragraphs.map((p) => (
        <Para key={p.id} p={p} savedLemmas={savedSet} />
      ))}
      {pick && (
        <PickCard
          pick={pick}
          onClose={close}
          onSave={(aiGloss?: string) => saveWord(pick, aiGloss)}
        />
      )}

      {floats.map((f) => (
        <div key={f.id} className="duo-float-up" style={{ left: f.x, top: f.y }}>
          {f.text}
        </div>
      ))}
    </div>
  );
}

// ====== PickCard：三层递进释义面板 ======

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
  onClose,
  onSave,
}: {
  pick: Pick;
  onClose: () => void;
  onSave: (aiGloss?: string) => void;
}) {
  const { anchor, paragraphIdx, x, y } = pick;
  // 标题字号随内容长度收缩：单词大字，短语中字，整句小字并限行
  const quote = anchor.quote.trim();
  const titleSize = quote.length > 60 ? 15 : quote.length > 28 ? 16 : quote.length > 14 ? 18 : 20;
  const W = 360;
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  const vh = typeof window === "undefined" ? 900 : window.innerHeight;
  const left = Math.min(Math.max(x, W / 2 + 16), vw - W / 2 - 16);

  // 垂直定位：优先放在落点下方，下方放不下翻到上方，
  // 最后再把 top 夹进视口（弹层高度上限 H_MAX），保证永远不会被挤出屏幕。
  const H_MAX = Math.min(560, Math.max(320, vh - 32));
  const GAP = 14;
  let top = y + GAP;
  if (top + H_MAX > vh - 16) top = y - GAP - H_MAX;
  top = Math.max(16, Math.min(top, vh - H_MAX - 16));
  const maxHeight = Math.min(H_MAX, vh - top - 16);

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

  // 如果是短语，词典查不到，直接建议走 AI
  const suggestAI = isPhrase || (!dictLoading && !dict?.entry);

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
      className="fixed z-50 duo-anim-pop"
      style={{
        left,
        top,
        width: W,
        maxHeight,
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="duo-popover" style={{ display: "flex", flexDirection: "column", minHeight: 0, maxHeight: "100%" }}>
        {/* 标题区：白底 + 分隔线，不再用蓝色块 */}
        <div className="px-5 pt-4 pb-3" style={{ borderBottom: "2px solid var(--duo-border)" }}>
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
              {/* 收词按钮放在标题栏：既显眼又不占用底部空间 */}
              <button
                className="duo-icon-btn duo-icon-btn-sm"
                onClick={() => {
                  onSave(aiStatus === "done" ? aiText : undefined);
                  onClose();
                }}
                title="收进词库"
                aria-label="收进词库"
              >
                +
              </button>
              <button
                onClick={onClose}
                className="text-ink-faint hover:text-ink-soft text-[15px] leading-none px-0.5 font-bold"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
          </div>
        </div>

        {/* 释义区 */}
        <div className="px-5 py-4 overflow-y-auto" style={{ flex: "1 1 auto", minHeight: 0 }}>
          {/* 第 1 层：词典 */}
          {dictLoading ? (
            <div className="text-center py-3">
              <p className="text-[14px] font-bold text-ink-faint">查词典中…</p>
            </div>
          ) : dict?.entry ? (
            <DictView entry={dict.entry} lemmaForm={dict.lemmaForm} originalForm={dict.originalForm} />
          ) : (
            <div
              className="rounded-xl px-4 py-3 text-center"
              style={{ background: "var(--duo-surface)" }}
            >
              <p className="text-[14px] font-bold text-ink-faint">
                {isPhrase ? "短语不在词典中" : "词典未收录"}
              </p>
              <p className="text-[13px] text-ink-faint mt-0.5">
                点击下方按钮用 AI 解释
              </p>
            </div>
          )}

          {/* 第 2 层：AI 释义 —— 与词典卡同一中性底色，仅徽章用品牌绿 */}
          {aiStatus !== "idle" && (
            <div className="mt-3 rounded-xl p-4" style={{ background: "var(--duo-surface)" }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="duo-badge duo-badge-green">AI 解释</span>
                {aiStatus === "loading" && (
                  <span className="text-[12px] font-bold text-ink-faint">正在思考…</span>
                )}
                {aiStatus === "streaming" && (
                  <span className="text-[12px] font-bold" style={{ color: "var(--duo-green-dark)" }}>
                    生成中…
                  </span>
                )}
              </div>
              <div
                className="text-[14px] leading-relaxed whitespace-pre-wrap"
                style={{ color: "var(--duo-ink)" }}
              >
                {aiText}
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
                  className="duo-btn duo-btn-primary duo-btn-sm flex-1"
                  onClick={() => {
                    if (askPrompt.trim()) {
                      triggerAI(askPrompt.trim());
                      setShowAskInput(false);
                    }
                  }}
                >
                  提问
                </button>
                <button
                  className="duo-btn duo-btn-white duo-btn-sm"
                  style={{ color: "var(--duo-ink-soft)" }}
                  onClick={() => setShowAskInput(false)}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 收词按钮已移到标题栏 */}
        </div>

        {/* 底部固定操作条：不随内容滚动 */}
        <div
          className="px-5 py-3"
          style={{ background: "var(--duo-bg)", borderTop: "2px solid var(--duo-border)", flex: "0 0 auto" }}
        >
          {aiStatus === "idle" && (
            <div className="duo-action-row">
              <button className="duo-btn duo-btn-primary duo-btn-sm" onClick={() => triggerAI()}>
                {suggestAI ? "🔍 用 AI 解释" : "AI 深度释义"}
              </button>
            </div>
          )}

          {aiStatus !== "idle" && !showAskInput && (
            <div className="duo-action-row">
              <button
                className="duo-btn duo-btn-white duo-btn-sm"
                style={{ color: "var(--duo-ink-soft)" }}
                onClick={() => setShowAskInput(true)}
              >
                追问
              </button>
            </div>
          )}
        </div>

        {/* 锚点信息 */}
        <details className="px-5 py-3" style={{ background: "var(--duo-surface)", borderTop: "2px solid var(--duo-border)" }}>
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
    <div className="rounded-xl p-4" style={{ background: "var(--duo-surface)" }}>
      {showLemma && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className="duo-badge duo-badge-green">{lemmaForm}</span>
          <span className="text-[12px] font-bold text-ink-faint">← 原形</span>
        </div>
      )}

      {entry.translation && (
        <p className="text-[15px] font-medium leading-relaxed text-ink mb-2 whitespace-pre-line">
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

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

  function onMouseUp() {
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

    const rect = range.getBoundingClientRect();
    setPick({
      paragraphId: pid,
      paragraphIdx: p.idx,
      anchor: buildAnchor(p.content, start, end),
      x: rect.left + rect.width / 2,
      y: rect.bottom,
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
  const W = 360;
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  const vh = typeof window === "undefined" ? 900 : window.innerHeight;
  const left = Math.min(Math.max(x, W / 2 + 16), vw - W / 2 - 16);

  // 垂直定位：优先放在词下方；下方放不下就翻到上方；上下都放不下就贴着视口顶部。
  // 弹层高度会随 AI 内容变化，所以这里用一个保守的预估高度做判断，
  // 同时给弹层本身加 max-height，内容再长也不会溢出视口。
  const ESTIMATED_H = 420;
  const belowY = y + 12;
  const aboveY = y - 12;
  const flipUp = belowY + ESTIMATED_H > vh - 16;
  const top = flipUp ? Math.max(16, aboveY - 320) : belowY;

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
        maxHeight: `min(${Math.round(vh - top - 16)}px, 560px)`,
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="duo-popover" style={{ display: "flex", flexDirection: "column", minHeight: 0, maxHeight: "100%" }}>
        {/* 标题区 */}
        <div className="px-5 pt-4 pb-3" style={{ background: "var(--duo-blue-soft)" }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[20px] font-extrabold leading-snug break-words text-ink">
                {anchor.quote}
              </p>
              {dict?.entry?.phonetic && (
                <p className="text-[13px] font-mono text-ink-soft mt-0.5">
                  /{normalizePhonetic(dict.entry.phonetic)}/
                </p>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {/* 收词按钮放在标题栏：既显眼又不占用底部空间 */}
              <button
                className="duo-icon-btn"
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
                className="text-ink-faint hover:text-ink-soft text-[18px] leading-none px-1 font-bold"
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

          {/* 第 2 层：AI 释义 */}
          {aiStatus !== "idle" && (
            <div className="mt-3 rounded-xl p-4" style={{ background: "var(--duo-purple-soft)" }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="duo-badge duo-badge-purple">AI 解释</span>
                {aiStatus === "loading" && (
                  <span className="text-[12px] font-bold text-ink-faint">正在思考…</span>
                )}
                {aiStatus === "streaming" && (
                  <span className="text-[12px] font-bold" style={{ color: "var(--duo-purple-dark)" }}>
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
                  <span className="inline-block w-1.5 h-4 ml-0.5 align-middle animate-pulse" style={{ background: "var(--duo-purple)" }} />
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
                  className="duo-btn duo-btn-blue duo-btn-sm flex-1"
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
              <button
                className="duo-btn duo-btn-blue duo-btn-sm"
                onClick={() => triggerAI()}
              >
                {suggestAI ? "🔍 用 AI 解释" : "🤖 AI 深度释义"}
              </button>
            </div>
          )}

          {aiStatus !== "idle" && !showAskInput && (
            <div className="duo-action-row">
              <button
                className="duo-btn duo-btn-white duo-btn-sm"
                onClick={() => setShowAskInput(true)}
              >
                💬 追问
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
    <div className="rounded-xl p-4" style={{ background: "var(--duo-green-soft)" }}>
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

"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildAnchor, tokenize, type Anchor, type Token } from "@/lib/tokenize";
import { groupBlocks, isSkipped, type Group } from "@/lib/import/group";
import { isProse, type BlockKind, type BlockMeta, type InlineRange } from "@/lib/import/types";
import { aiContextOf, selectionSignals, type SelectionSignals } from "@/lib/sentence";
import { planSections, type Section } from "@/lib/sections";
import { normalizePhonetic, normalizeTranslation } from "@/lib/text";
import { speak, canSpeak } from "@/lib/speak";
import { STREAM_RESET } from "@/lib/config";
import MarkdownText from "@/components/MarkdownText";

/**
 * 一个 Block IR 落库后的一行。content 仍是「用户可见的纯文本」，
 * 所以 data-s/data-e、contexts.start/end 的坐标语义和纯文本时代完全一致。
 * 新增的三个字段只负责「怎么排版」，不参与任何坐标计算。
 */
type Para = {
  id: string;
  idx: number;
  content: string;
  blockType?: string | null;
  blockMeta?: BlockMeta;
  inlineRanges?: InlineRange[];
};
export type ReaderPara = Para;

const CALLOUT_LABEL: Record<string, string> = {
  NOTE: "提示",
  TIP: "技巧",
  WARNING: "注意",
  IMPORTANT: "重要",
  CAUTION: "小心",
};

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
  /** 拖选自动入库后对应的 context id，用于回填 AI 释义 / 回看 */
  contextId?: string;
  /** 从已存批注回看时，直接展示当时保存的 AI 释义，不重新请求 */
  initialGloss?: string;
  /** 这次选区采集的客观信号，随 /api/explain 送给模型（不是结论） */
  signals?: SelectionSignals;
};

/** 一篇文本里已保存的句子/短语批注（来自 contexts 表） */
type Annotation = {
  id: string;
  wordId: string;
  paragraphId: string;
  paragraphIdx: number;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  aiGloss: string | null;
  createdAt: number;
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

function pidProps(p: Para) {
  return { "data-pid": p.id, "data-idx": p.idx } as const;
}

/** inline 样式只影响 className，绝不影响 data-s/data-e 的字符坐标。 */
function styleClassesFor(t: { start: number; end: number }, ranges: InlineRange[]): string {
  const out: string[] = [];
  for (const r of ranges) {
    if (t.start >= r.start && t.end <= r.end) out.push(`rf-i-${r.kind}`);
  }
  return out.join(" ");
}

function renderTokens(p: Para, rangeKey: string): React.ReactNode[] {
  const tokens = tokenize(p.content);
  const ranges = p.inlineRanges ?? [];
  const links = ranges.filter((r) => r.kind === "link" && r.href);
  const annotatedRanges = rangeKey
    .split(",")
    .filter(Boolean)
    .map((s) => {
      const [a, b] = s.split("-").map(Number);
      return { start: a, end: b };
    });

  const one = (t: Token): React.ReactNode => {
    if (!t.word) return <span key={`t${t.start}`}>{t.text}</span>;
    /* 标记只反映「这次批注」：划选存档的那一次出现（w-annotated）。
       不做词库级全局标记——同一个词在别的句子里可能你是懂的，
       全文铺绿既误导又破坏「单词放在句子语境里解释」的原则 */
    const annotated = annotatedRanges.some((r) => t.end > r.start && t.start < r.end);
    const cls = ["w", annotated ? "w-annotated" : "", styleClassesFor(t, ranges)]
      .filter(Boolean)
      .join(" ");
    return (
      <span key={`t${t.start}`} className={cls} data-s={t.start} data-e={t.end}>
        {t.text}
      </span>
    );
  };

  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const lk = links.find((l) => t.start >= l.start && t.end <= l.end);
    if (!lk) {
      out.push(one(t));
      i++;
      continue;
    }
    // 同一个链接跨多个 token 时，把它们一起包进 <a>；
    // <a> 是 data-pid 容器的后代，closest(".w") / closest("[data-pid]") 仍然成立
    const group: Token[] = [];
    let j = i;
    while (j < tokens.length && tokens[j].start >= lk.start && tokens[j].end <= lk.end) {
      group.push(tokens[j]);
      j++;
    }
    out.push(
      <a key={`a${lk.start}`} href={lk.href} target="_blank" rel="noreferrer" className="rf-inline-link">
        {group.map(one)}
      </a>,
    );
    i = j;
  }
  return out;
}

const Tokens = memo(function Tokens({ p, rangeKey }: { p: Para; rangeKey: string }) {
  const nodes = useMemo(
    () => renderTokens(p, rangeKey),
    [p.content, p.inlineRanges, rangeKey],
  );
  return <>{nodes}</>;
});

/** 单个块：容器标签随 kind 变，但 data-pid 永远挂在最外层可见容器上。 */
const SingleBlock = memo(function SingleBlock({ p, rangeKey }: { p: Para; rangeKey: string }) {
  const kind = (p.blockType ?? "paragraph") as BlockKind;
  const meta = p.blockMeta ?? {};
  const pid = pidProps(p);

  switch (kind) {
    case "heading": {
      // 正文里的 h1 降级成 h2：阅读页标题已经是 h1，别出现两个
      const level = Math.min(6, Math.max(2, (meta.depth ?? 2) + 1));
      const Tag = `h${level}` as React.ElementType;
      return (
        <Tag {...pid} className={`rf-h rf-h${level}`}>
          <Tokens p={p} rangeKey={rangeKey} />
        </Tag>
      );
    }
    case "quote": {
      const callout = meta.callout;
      const cls = [
        "rf-quote",
        callout ? `rf-callout rf-callout-${callout.toLowerCase()}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      // 提示框标签用 CSS ::before + data-label：伪元素不进入 DOM 文本，
      // 否则 Range.toString() 会把它算进段落偏移，锚点就全错了
      return (
        <blockquote {...pid} className={cls} data-label={callout ? CALLOUT_LABEL[callout] ?? callout : undefined}>
          <Tokens p={p} rangeKey={rangeKey} />
        </blockquote>
      );
    }
    case "code":
      // 代码块不生成 .w 可点词 span：pnpm / json / __init__ 不是要背的单词
      return (
        <pre {...pid} className="rf-pre" data-label={meta.lang || "代码"}>
          <code>{p.content}</code>
        </pre>
      );
    case "hr":
      return <hr {...pid} className="rf-hr" />;
    case "figure":
      return (
        <figure {...pid} className="rf-figure">
          <figcaption>{p.content}</figcaption>
        </figure>
      );
    case "list_item":
      return (
        <li {...pid} className="rf-li">
          <Tokens p={p} rangeKey={rangeKey} />
        </li>
      );
    case "table_cell":
      return (
        <span {...pid} className="rf-cell-inline">
          <Tokens p={p} rangeKey={rangeKey} />
        </span>
      );
    default:
      return (
        <p {...pid}>
          <Tokens p={p} rangeKey={rangeKey} />
        </p>
      );
  }
});

/** 表格 cell / 列表 item 在库里各占一行，渲染时才重新组装回一个结构。 */
const GroupView = memo(function GroupView({
  group,
  rangeKeyByPara,
}: {
  group: Group<Para>;
  rangeKeyByPara: Map<string, string>;
}) {
  const keyOf = (p: Para) => rangeKeyByPara.get(p.id) ?? "";

  if (group.type === "table") {
    const [head, ...body] = group.rows;
    const Cell = (p: Para, isHead: boolean) => {
      const Tag = (isHead ? "th" : "td") as React.ElementType;
      return (
        <Tag
          key={p.id}
          {...pidProps(p)}
          className="rf-cell"
          style={{ textAlign: p.blockMeta?.align ?? undefined }}
        >
          <Tokens p={p} rangeKey={keyOf(p)} />
        </Tag>
      );
    };
    return (
      <div className="rf-table-scroll">
        <table className="rf-table">
          {head && (
            <thead>
              <tr>{head.map((p) => Cell(p, true))}</tr>
            </thead>
          )}
          <tbody>
            {body.map((row, i) => (
              <tr key={`r${i}`}>{row.map((p) => Cell(p, false))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (group.type === "list") {
    const Tag = (group.ordered ? "ol" : "ul") as React.ElementType;
    return (
      <Tag className="rf-list">
        {group.items.map((p) => (
          <li
            key={p.id}
            {...pidProps(p)}
            className={`rf-li${(p.blockMeta?.listDepth ?? 0) > 0 ? " rf-li-nested" : ""}`}
            data-list-depth={p.blockMeta?.listDepth ?? 0}
          >
            <Tokens p={p} rangeKey={keyOf(p)} />
          </li>
        ))}
      </Tag>
    );
  }

  return <SingleBlock p={group.items[0]} rangeKey={keyOf(group.items[0])} />;
});

/** 一个小结区间的加载状态 */
type SectionState = {
  status: "loading" | "streaming" | "done" | "error";
  content: string;
};

/**
 * 分段小结标记（对齐 Readlang）：段落之间一条细线 + 中间一个 ? 圆点。
 * 点击在标记**下方原地**展开小结面板，流式输出；这一区间已生成过则显示圆点提示。
 * 位置由 planSections 决定，永远落在自然段结束后——绝不把一段切开。
 */
const SectionMark = memo(function SectionMark({
  section,
  state,
  open,
  cached,
  onToggle,
  onRegenerate,
  onClose,
}: {
  section: Section;
  state?: SectionState;
  open: boolean;
  /** 这一区间已有缓存（标记上显示小圆点） */
  cached: boolean;
  onToggle: () => void;
  onRegenerate: () => void;
  onClose: () => void;
}) {
  const label = `第 ${section.startIdx + 1}–${section.endIdx + 1} 段 · ${section.words} 词`;
  return (
    <div
      className="rf-sec"
      onClick={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="rf-sec-rail">
        <span className="rf-sec-line" />
        <button
          type="button"
          className={`rf-sec-btn${open ? " is-open" : ""}`}
          onClick={onToggle}
          title={`查看这一部分的小结（${label}）`}
          aria-label={`查看第 ${section.startIdx + 1} 到 ${section.endIdx + 1} 段的小结`}
          aria-expanded={open}
        >
          ?
          {cached && !open && <span className="rf-sec-dot" aria-hidden />}
        </button>
        <span className="rf-sec-line" />
      </div>

      {open && (
        <div className="rf-sec-panel">
          <div className="rf-sec-head">
            <span className="rf-sec-title">这一部分讲了什么</span>
            <span className="rf-sec-range">{label}</span>
            <span className="rf-sec-actions">
              {state?.status !== "loading" && state?.status !== "streaming" && (
                <button type="button" className="rf-sec-act" onClick={onRegenerate}>
                  重新生成
                </button>
              )}
              <button type="button" className="rf-sec-act" onClick={onClose}>
                收起
              </button>
            </span>
          </div>

          {state?.status === "error" ? (
            <div className="rf-sec-error">
              <span>生成失败：{state.content}</span>
              <button type="button" className="rf-sec-act" onClick={onRegenerate}>
                重试
              </button>
            </div>
          ) : !state || (state.status === "loading" && !state.content) ? (
            <p className="rf-sec-hint">正在读这一部分…</p>
          ) : (
            <div className="rf-md rf-sec-text">
              <MarkdownText text={state.content} />
              {state.status === "streaming" && <span className="rf-sec-caret" />}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export type SavedWordInfo = {
  id: string;
  lemma: string;
  displayForm: string;
  translation: string;
  status: string; // learning | learned
  starred: number;
  /** 本次点击新建的词条；用于「收起即撤销」 */
  created?: boolean;
  /** 本次落库产生的 context id（拖选批注用） */
  contextId?: string;
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
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 场景 4：同一句里连续请教的次数。只放内存、不落库——「这句卡了三次」是
  // 阅读会话内的瞬时状态，不该变成被永久记住的用户数据。
  // key 用「段落 + 句子区间」：换句自动归零，翻页/刷新随组件重挂载清零。
  const sentenceAskRef = useRef<{ key: string; count: number }>({ key: "", count: 0 });

  function noteSelection(sig: SelectionSignals, paragraphId: string): number {
    const key = `${paragraphId}:${sig.sentenceStart}:${sig.sentenceEnd}`;
    const cur = sentenceAskRef.current;
    if (cur.key === key) cur.count += 1;
    else sentenceAskRef.current = { key, count: 1 };
    return sentenceAskRef.current.count;
  }

  // 已收词表（含状态），键为小写 displayForm / lemma
  const [savedMap, setSavedMap] = useState<Map<string, SavedWordInfo>>(() =>
    buildSavedMap(savedWords),
  );

  // ===== 分段小结 =====
  // 按累计词数分区（约 300 词一段区间），只在自然段末尾落标记，绝不拆段
  const sections = useMemo(
    () =>
      planSections(
        paragraphs
          // 代码块 / 分隔线 / 图片不是散文，不该参与区间词数累计，
          // 服务端 /api/summarize 用完全相同的过滤规则
          .filter((p) => isProse({ kind: (p.blockType ?? "paragraph") as BlockKind }))
          .map((p) => ({ idx: p.idx, content: p.content })),
      ),
    [paragraphs],
  );
  const sectionByEnd = useMemo(
    () => new Map(sections.map((s) => [s.endIdx, s] as const)),
    [sections],
  );
  /** 已生成过的小结（key = 区间结束段 idx） */
  const [summaries, setSummaries] = useState<Record<number, string>>({});
  const [secState, setSecState] = useState<Record<number, SectionState>>({});
  const [openSec, setOpenSec] = useState<number | null>(null);

  /** 拉取本文已有小结，标记上据此显示圆点 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/summarize?textId=${encodeURIComponent(textId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        const map: Record<number, string> = {};
        for (const s of data.summaries ?? []) map[s.endIdx] = s.content;
        setSummaries(map);
      } catch {
        /* 静默失败：小结是增强功能，不影响正文阅读 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [textId]);

  /** 生成（或重新生成）某个区间的小结，流式回填 */
  async function runSummary(sec: Section, regenerate: boolean) {
    setOpenSec(sec.endIdx);
    setSecState((prev) => ({ ...prev, [sec.endIdx]: { status: "loading", content: "" } }));
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          textId,
          startIdx: sec.startIdx,
          endIdx: sec.endIdx,
          ...(regenerate ? { regenerate: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("无法读取流");

      const decoder = new TextDecoder();
      let text = "";
      setSecState((prev) => ({ ...prev, [sec.endIdx]: { status: "streaming", content: "" } }));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        // 服务端重试时会吐重置标记，丢掉上一次的半成品
        if (text.includes(STREAM_RESET)) text = text.split(STREAM_RESET).pop() ?? "";
        setSecState((prev) => ({ ...prev, [sec.endIdx]: { status: "streaming", content: text } }));
      }

      setSecState((prev) => ({ ...prev, [sec.endIdx]: { status: "done", content: text } }));
      setSummaries((prev) => ({ ...prev, [sec.endIdx]: text }));
    } catch (err) {
      setSecState((prev) => ({
        ...prev,
        [sec.endIdx]: {
          status: "error",
          content: err instanceof Error ? err.message : "生成失败",
        },
      }));
    }
  }

  function toggleSection(sec: Section) {
    if (openSec === sec.endIdx) {
      setOpenSec(null);
      return;
    }
    setOpenSec(sec.endIdx);
    if (secState[sec.endIdx]) return; // 已有内容 / 错误态，直接展开
    const cached = summaries[sec.endIdx];
    if (cached) {
      setSecState((prev) => ({
        ...prev,
        [sec.endIdx]: { status: "done", content: cached },
      }));
      return;
    }
    void runSummary(sec, false);
  }

  /** 拉取本文已保存的句子/短语批注（回看列表） */
  const loadAnnotations = useCallback(async () => {
    try {
      const res = await fetch(`/api/annotations?textId=${encodeURIComponent(textId)}`);
      if (!res.ok) return;
      const data = await res.json();
      setAnnotations(data.annotations ?? []);
    } catch {
      /* 静默失败：批注列表是增强功能，不影响正文阅读 */
    }
  }, [textId]);

  useEffect(() => {
    void loadAnnotations();
  }, [loadAnnotations]);

  useEffect(() => {
    setAutoSave(localStorage.getItem("readflow.autoSave") !== "0");
    // 自动收词开关已挪到右上角用户菜单；菜单变更时广播事件，这里同步状态
    function onAutoSaveChange(e: Event) {
      const next = (e as CustomEvent<boolean>).detail;
      if (typeof next === "boolean") setAutoSave(next);
    }
    window.addEventListener("readflow.autosave", onAutoSaveChange);
    return () => window.removeEventListener("readflow.autosave", onAutoSaveChange);
  }, []);

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

  // 每段已存批注的字符范围，序列化成字符串传给 memo 化的块（避免长文全量重渲染）
  const rangeKeyByPara = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of annotations) {
      m.set(a.paragraphId, (m.get(a.paragraphId) ?? "") + `${a.start}-${a.end},`);
    }
    return m;
  }, [annotations]);

  // 分组是纯函数（服务端/客户端结果一致），不会引入 hydration 差异
  const groups = useMemo(
    () => groupBlocks(paragraphs.filter((p) => !isSkipped(p))),
    [paragraphs],
  );

  function onClick(e: React.MouseEvent) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;

    const wordEl = (e.target as HTMLElement).closest<HTMLElement>(".w");
    if (!wordEl) {
      close();
      return;
    }
    // 链接里的词：点词优先弹释义，别直接跳走（冒泡阶段阻止默认行为仍生效）
    if ((e.target as HTMLElement).closest("a.rf-inline-link")) e.preventDefault();
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

    const sig = selectionSignals(p.content, s, en, "word");
    const pickData: Pick = {
      paragraphId: pid,
      paragraphIdx: p.idx,
      anchor: buildAnchor(p.content, s, en),
      x: rect.left + rect.width / 2,
      y: rect.bottom,
      source: "word",
      signals: { ...sig, repeatCount: noteSelection(sig, pid) },
    };
    markActiveAnchor([wordEl]);
    setPick(pickData);

    // 已收过的词：右栏直接展示已存释义，不再请求
    const saved = savedMap.get(key) ?? null;
    if (saved) return;
    if (!autoSave) return;

    // 自动收词：落库后回填 justSaved（收起批注时可撤销）；
    // 并刷新批注列表——单词那次出现的持久绿虚线（w-annotated）由此而来
    void saveWord(pickData).then((info) => {
      setPick((cur) =>
        cur && cur.source === "word" && cur.anchor.quote.toLowerCase() === key
          ? { ...cur, justSaved: info?.created === true }
          : cur,
      );
      if (info) void loadAnnotations();
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
    const sig = selectionSignals(p.content, start, end, "select");
    const pickData: Pick = {
      paragraphId: pid,
      paragraphIdx: p.idx,
      anchor: buildAnchor(p.content, start, end),
      x: e.clientX,
      y: e.clientY,
      source: "select",
      signals: { ...sig, repeatCount: noteSelection(sig, pid) },
    };
    setPick(pickData);

    // 与点词一致：自动收词开时，拖选的句子/短语也自动入库。
    // 关掉批注后仍能从「已存批注」翻回去看，不用重新选中。
    if (autoSave && /\s/.test(pickData.anchor.quote.trim())) {
      void autoSaveSelection(pickData);
    }
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
        contextId: data.contextId,
      };
      setSavedMap((prev) => {
        const next = new Map(prev);
        next.set(info.displayForm.toLowerCase(), info);
        if (info.lemma) next.set(info.lemma.toLowerCase(), info);
        return next;
      });
      celebrate(pickData.x, pickData.y - 20, /\s/.test(anchor.quote.trim()) ? "+1 批注" : "+1 词");
      return info;
    } catch {
      return null;
    }
  }

  /** 拖选自动入库：落库后把 contextId 挂到当前 pick，并刷新回看列表 */
  async function autoSaveSelection(pickData: Pick) {
    const info = await saveWord(pickData);
    if (!info?.contextId) return;
    setPick((cur) =>
      cur &&
      cur.source === "select" &&
      cur.paragraphId === pickData.paragraphId &&
      cur.anchor.start === pickData.anchor.start &&
      cur.anchor.end === pickData.anchor.end
        ? { ...cur, contextId: info.contextId, justSaved: info.created === true }
        : cur,
    );
    await loadAnnotations();
  }

  /** AI 释义生成完成后回填到批注，翻回去看时不用重新请求 AI */
  async function persistGloss(pickData: Pick, gloss: string) {
    if (!pickData.contextId) return;
    try {
      const res = await fetch(`/api/contexts/${pickData.contextId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiGloss: gloss }),
      });
      if (!res.ok) return;
      setAnnotations((prev) =>
        prev.map((a) => (a.id === pickData.contextId ? { ...a, aiGloss: gloss } : a)),
      );
    } catch {
      /* 静默失败 */
    }
  }

  /** 从「已存批注」列表回看：重建批注卡 + 滚动到原文 + 显示已存释义 */
  function openAnnotation(a: Annotation) {
    const para = paragraphs.find((x) => x.id === a.paragraphId);
    const sig = para ? selectionSignals(para.content, a.start, a.end, "select") : undefined;
    const pd: Pick = {
      signals: sig,
      paragraphId: a.paragraphId,
      paragraphIdx: a.paragraphIdx,
      anchor: {
        start: a.start,
        end: a.end,
        quote: a.quote,
        prefix: a.prefix,
        suffix: a.suffix,
      },
      x: 0,
      y: 0,
      source: "select",
      contextId: a.id,
      initialGloss: a.aiGloss ?? undefined,
    };
    const pEl = document.querySelector<HTMLElement>(`[data-pid="${a.paragraphId}"]`);
    if (pEl) {
      const els = [...pEl.querySelectorAll<HTMLElement>(".w")].filter(
        (el) => Number(el.dataset.e) > a.start && Number(el.dataset.s) < a.end,
      );
      markActiveAnchor(els);
      pEl.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    setPick(pd);
  }

  /**
   * 移除一条已存批注（×）。
   * 批注按词去重后一条记录代表这个词在本文的标记，
   * 所以删的是该词在本文的全部 context，避免更早的记录重新浮出来。
   * 若占位词条（句子/短语）已无任何 context，服务端会连带删掉词条。
   * 前端同步：批注列表、正文高亮、savedMap 三处一起清。
   */
  async function removeAnnotation(a: Annotation) {
    let prunedWord = false;
    try {
      const res = await fetch(`/api/words/${a.wordId}?textId=${textId}`, { method: "DELETE" });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      prunedWord = data.prunedWord === true;
    } catch {
      return;
    }
    setAnnotations((prev) => prev.filter((x) => x.wordId !== a.wordId));
    if (prunedWord) {
      // 占位词条已被服务端删除：从 savedMap 移除，保持 ✓/+ 状态一致
      setSavedMap((prev) => {
        const next = new Map(prev);
        for (const [k, v] of next) {
          if (v.id === a.wordId) next.delete(k);
        }
        return next;
      });
    }
    if (pick?.contextId === a.id) close();
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

  /** 从词库删除（彻底删除）：删词 = 已掌握，不留「已移出」的中间态 */
  async function removeWord(id: string) {
    try {
      const res = await fetch(`/api/words/${id}`, { method: "DELETE" });
      if (!res.ok) return;
    } catch {
      /* 静默失败 */
    }
    setSavedMap((prev) => {
      const next = new Map(prev);
      for (const [k, v] of next) {
        if (v.id === id) next.delete(k);
      }
      return next;
    });
  }

  return (
    <div className="reader-split">
      {/* 左栏（61.8%）：正文 */}
      <div className="reader-main">
        <div className="duo-card reader-article-card">
          <div className="reading-body" ref={bodyRef} onClick={onClick} onMouseUp={onMouseUp}>
            {groups.map((g, gi) => {
              // 小结标记按自然段 idx 落点；一个分组可能含多个 idx（表格/列表），
              // 取组内最后一个命中，保证标记不会因为分组被吞掉
              let hitSec: Section | undefined;
              for (const p of g.items) {
                const hit = sectionByEnd.get(p.idx);
                if (hit) hitSec = hit;
              }
              const sec = hitSec;
              return (
                <Fragment key={`g${gi}`}>
                  <GroupView group={g} rangeKeyByPara={rangeKeyByPara} />
                  {sec && (
                    <SectionMark
                      section={sec}
                      state={secState[sec.endIdx]}
                      open={openSec === sec.endIdx}
                      cached={summaries[sec.endIdx] !== undefined}
                      onToggle={() => toggleSection(sec)}
                      onRegenerate={() => void runSummary(sec, true)}
                      onClose={() => setOpenSec(null)}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* 右栏（38.2%）：查词卡在顶，已存批注随之下移；滚动时吸附在顶栏下方 */}
      <aside className="reader-aside">
        {pick ? (
          <PickCard
            key={`${pick.paragraphId}:${pick.anchor.start}:${pick.anchor.end}:${pick.source}`}
            pick={pick}
            saved={savedMap.get(pick.anchor.quote.toLowerCase()) ?? null}
            onClose={close}
            initialGloss={pick.initialGloss}
            /* AI 上下文按情况截取：单词/短语 → 所在整句；划整句 → 相邻句补语境；
               「没看懂整句」信号（覆盖 ≥75% 词汇或句内生词密度 ≥75%）→ 前文额外带上一句 */
            aiContext={(() => {
              const idx = paragraphs.findIndex((p) => p.id === pick.paragraphId);
              const para = idx >= 0 ? paragraphs[idx] : undefined;
              return para
                ? aiContextOf(para.content, pick.anchor.start, pick.anchor.end, {
                    savedSet: new Set(savedMap.keys()),
                    prevParagraph: idx > 0 ? paragraphs[idx - 1].content : undefined,
                  })
                : { prefix: pick.anchor.prefix, suffix: pick.anchor.suffix };
            })()}
            onAIGloss={(text) => void persistGloss(pick, text)}
            onSave={(aiGloss?: string) => {
              if (pick.contextId) {
                // 拖选已自动入库：只补 AI 释义，避免重复插一条 context
                if (aiGloss) void persistGloss(pick, aiGloss);
                return;
              }
              void saveWord(pick, aiGloss).then(async (info) => {
                if (!info?.contextId) return;
                setPick((cur) =>
                  cur &&
                  cur.paragraphId === pick.paragraphId &&
                  cur.anchor.start === pick.anchor.start &&
                  cur.anchor.end === pick.anchor.end
                    ? { ...cur, contextId: info.contextId }
                    : cur,
                );
                await loadAnnotations();
              });
            }}
            onDelete={() => {
              const info = savedMap.get(pick.anchor.quote.toLowerCase());
              if (info) void removeWord(info.id).then(() => loadAnnotations());
            }}
            onUndo={() => {
              const info = savedMap.get(pick.anchor.quote.toLowerCase());
              close();
              if (info) void unsaveWord(info, pick.anchor.quote.toLowerCase()).then(() => loadAnnotations());
            }}
          />
        ) : (
          <p className="reader-hint">点击文中单词，或拖住一句话 —— 释义会显示在这里</p>
        )}

        {/* 已存批注：拖选过的句子/短语自动入库，点一条即可翻回去看 */}
        <div className="rf-annots">
          <button className="rf-annots-head" onClick={() => setShowAnnotations((v) => !v)}>
            <span>
              已存批注 <b>{annotations.length}</b>
            </span>
            <span className="rf-annots-toggle">{showAnnotations ? "收起" : "展开"}</span>
          </button>
          {showAnnotations && (
            <div className="rf-annots-list">
              {annotations.length === 0 ? (
                <p className="rf-annots-empty">点过的词、划过的句子都会存到这里，随时翻回去看</p>
              ) : (
                annotations.map((a) => (
                  <div
                    key={a.id}
                    className={`rf-annot-item${pick?.contextId === a.id ? " is-active" : ""}`}
                  >
                    <button className="rf-annot-open" onClick={() => openAnnotation(a)} title={a.quote}>
                      <span className="rf-annot-quote">{a.quote.trim()}</span>
                      <span className="rf-annot-meta">
                        第 {a.paragraphIdx + 1} 段{a.aiGloss ? " · 已存 AI 释义" : ""}
                      </span>
                    </button>
                    <button
                      className="rf-annot-del"
                      onClick={() => void removeAnnotation(a)}
                      aria-label="移除这条批注"
                      title="移除这条批注"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
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

function PickCard({
  pick,
  saved,
  onClose,
  onSave,
  onDelete,
  onUndo,
  initialGloss,
  onAIGloss,
  aiContext,
}: {
  pick: Pick;
  saved: SavedWordInfo | null;
  onClose: () => void;
  onSave: (aiGloss?: string) => void;
  onDelete: () => void;
  /** 撤销本次自动收词（仅本次新建的词条会出现） */
  onUndo: () => void;
  /** 回看已存批注时，直接展示当时保存的 AI 释义 */
  initialGloss?: string;
  /** AI 释义生成完成后回调，用于把结果写回该批注 */
  onAIGloss?: (text: string) => void;
  /** AI 用的上下文（句子边界 + 按需带上一句；锚点的 40 字符窗口只够定位，会切碎句子） */
  aiContext: { prefix: string; suffix: string; withPrevSentence?: boolean };
}) {
  const { anchor, paragraphIdx } = pick;
  // 标题字号随内容长度收缩：单词大字，短语中字，整句小字并限行
  const quote = anchor.quote.trim();
  const titleSize = quote.length > 60 ? 15 : quote.length > 28 ? 16 : quote.length > 14 ? 18 : 20;

  // 词典查询
  const [dict, setDict] = useState<DictResult | null>(null);
  const [dictLoading, setDictLoading] = useState(true);

  // AI 释义
  const [aiText, setAiText] = useState(initialGloss ?? "");
  const [aiStatus, setAiStatus] = useState<"idle" | "loading" | "streaming" | "done" | "error">(
    initialGloss ? "done" : "idle",
  );
  const [showAskInput, setShowAskInput] = useState(false);
  const [askPrompt, setAskPrompt] = useState("");
  /** 用户主动把「整句模式」改回按词回答（只影响本次弹层） */
  const [forceWordMode, setForceWordMode] = useState(false);

  // 场景 4：同句连续请教 ≥3 次时模型会按整句分析，这里给一个可撤销的入口
  const wholeSentenceMode = (pick.signals?.repeatCount ?? 0) >= 3 && !forceWordMode;

  // 是短语（含空格）还是单词
  const isPhrase = /\s/.test(anchor.quote.trim());

  // 弹层打开时自动查词典
  useEffect(() => {
    setDict(null);
    setDictLoading(true);
    setAiText(initialGloss ?? "");
    setAiStatus(initialGloss ? "done" : "idle");
    setShowAskInput(false);
    setAskPrompt("");
    setForceWordMode(false);

    fetch(`/api/dict?word=${encodeURIComponent(anchor.quote)}`)
      .then((r) => r.json())
      .then((data) => {
        setDict(data);
        setDictLoading(false);
      })
      .catch(() => setDictLoading(false));
  }, [anchor.quote, initialGloss]);

  /** 触发 AI 释义（流式）。forceWord = 把「按整句分析」临时改回按词回答。 */
  async function triggerAI(prompt?: string, forceWord = false) {
    setAiStatus("loading");
    setAiText("");

    // 客观信号：前端只采集证据，不下结论。词典命中在这里补（构造 Pick 时还没查词典）。
    const signals = pick.signals
      ? {
          ...pick.signals,
          dictHit: Boolean(dict?.entry),
          ...(forceWord ? { repeatCount: 0 } : {}),
        }
      : undefined;

    // 段落级上下文：选区 + 段内完整前文/后文（保证句子完整，不被锚点窗口截断）
    const body = {
      word: anchor.quote,
      prefix: aiContext.prefix,
      suffix: aiContext.suffix,
      ...(aiContext.withPrevSentence ? { withPrevSentence: true } : {}),
      language: "en",
      monolingual: false,
      ...(prompt ? { prompt } : {}),
      ...(signals ? { signals } : {}),
    };

    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
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
        // 服务端遇到限流/繁忙会自动重试，重开前吐一个重置标记：
        // 丢掉上一次的半成品，避免两段释义拼接显示
        if (text.includes(STREAM_RESET)) {
          text = text.split(STREAM_RESET).pop() ?? "";
        }
        setAiText(text);
      }

      setAiStatus("done");
      // 生成完成即写回该批注，翻回去看时不用重新请求 AI
      onAIGloss?.(text);
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
          {/* 收词按钮：已收显示 ✓（点击彻底删除），未收显示 + */}
          {saved ? (
            <button
              className="duo-icon-btn duo-icon-btn-sm duo-icon-btn-saved"
              onClick={onDelete}
              title="已在词库 · 点击删除"
              aria-label="已在词库，点击删除"
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
              <>
                {wholeSentenceMode && (
                  <button
                    className="rf-ask-mini"
                    title="这句连续请教了多次，已按整句分析；点这里改回按词回答"
                    onClick={() => {
                      setForceWordMode(true);
                      void triggerAI(undefined, true);
                    }}
                  >
                    已按整句分析 · 改按词答
                  </button>
                )}
                <button className="rf-ask-mini" onClick={() => setShowAskInput(true)}>
                  追问
                </button>
              </>
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


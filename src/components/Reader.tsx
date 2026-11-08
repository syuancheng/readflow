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
import { isNotAGloss, shouldAutoExplain } from "@/lib/explain-policy";
import { renderMath } from "@/lib/math";
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
  /** 从「已存批注」列表回看旧批注：不是新选区，不自动发起 AI 请求 */
  fromAnnotation?: boolean;
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

/**
 * data-rf-skip 子树（公式渲染视图）对选区坐标零贡献：
 * KaTeX 输出的字符（MathML 注解 + 渲染字形）不是 content 里的字符，
 * 只有同层的隐藏 LaTeX 原文（.rf-math-src）按原样计数——它恰好等于
 * content 里该公式的字符数，所以整段的「有效 DOM 文本」与 content 等长。
 */
function countText(n: Node): number {
  if (n.nodeType === 3) return n.textContent?.length ?? 0;
  if (n.nodeType === 1 && (n as Element).hasAttribute("data-rf-skip")) return 0;
  let c = 0;
  for (const ch of Array.from(n.childNodes)) c += countText(ch);
  return c;
}

/** node 之前（不含自身）的兄弟文本 */
function textBeforeNode(root: Node, node: Node): number {
  if (node === root) return 0;
  const parent = node.parentNode;
  if (!parent || !root.contains(node)) return 0;
  const idx = Array.prototype.indexOf.call(parent.childNodes, node);
  let c = textBeforeNode(root, parent);
  for (let i = 0; i < idx; i++) c += countText(parent.childNodes[i]);
  return c;
}

/**
 * 把 DOM 里的 (node, offset) 换算成段落内的字符偏移。
 *
 * 与 Range.toString().length 的区别：跳过 data-rf-skip 子树（公式视图），
 * 否则 KaTeX 渲染产物的字符会混进计数，公式之后所有词的偏移整体漂移。
 * 终点落在公式复合体内（视图或隐藏源）时，公式按原子处理：
 * 起点吸附到公式开头（data-s）、终点吸附到公式结尾（data-e）。
 */
function offsetIn(
  container: HTMLElement,
  node: Node,
  offset: number,
  side: "start" | "end",
): number {
  const composite = (
    node.nodeType === 1 ? (node as Element) : node.parentElement
  )?.closest<HTMLElement>(".rf-math-inline");
  if (composite && container.contains(composite)) {
    return side === "start" ? Number(composite.dataset.s) : Number(composite.dataset.e);
  }

  if (node === container) {
    // 终点是容器的 childIndex 形式：前 offset 个孩子的文本全计入
    let c = 0;
    for (let i = 0; i < offset && i < container.childNodes.length; i++) {
      c += countText(container.childNodes[i]);
    }
    return c;
  }
  if (node.nodeType === 3) {
    return textBeforeNode(container, node) + offset;
  }
  // 元素终点：(node, offset) = 该元素内第 offset 个孩子之前
  let c = textBeforeNode(container, node);
  for (let i = 0; i < offset && i < node.childNodes.length; i++) {
    c += countText(node.childNodes[i]);
  }
  return c;
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

/**
 * 行内公式（P17）：「视觉是图、坐标是文本」。
 *
 * 视觉层 .rf-math-view 是 KaTeX 渲染产物（和原网站 MathJax 同类观感）；
 * 坐标层 .rf-math-src 用 display:none 保留 LaTeX 原文——Range.toString()
 * 不受 CSS 影响，隐藏字符照样计入 offsetIn() 的字符偏移，
 * 所以拖选跨公式、点公式前后的词，锚点坐标与 content 严格一致。
 * 悬停 title 显示 LaTeX 源，方便核对。
 */
function InlineMath({ latex, start, end }: { latex: string; start: number; end: number }) {
  const html = useMemo(() => renderMath(latex, false), [latex]);
  if (!html) {
    // KaTeX 都渲染不出来（极端输入）：退回弱化源码样式，仍保留文本坐标
    return (
      <span className="rf-i-math" data-s={start} data-e={end}>
        {latex}
      </span>
    );
  }
  return (
    <span className="rf-math-inline" data-s={start} data-e={end} title={latex}>
      {/* data-rf-skip：渲染视图对选区坐标零贡献（见 offsetIn），MathML 部分留给屏幕阅读器 */}
      <span
        className="rf-math-view"
        data-rf-skip=""
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <span className="rf-math-src" aria-hidden="true">
        {latex}
      </span>
    </span>
  );
}

function renderTokens(p: Para, rangeKey: string): React.ReactNode[] {
  const tokens = tokenize(p.content);
  const ranges = p.inlineRanges ?? [];
  const links = ranges.filter((r) => r.kind === "link" && r.href);
  const mathRanges = ranges.filter((r) => r.kind === "math");
  const annotatedRanges = rangeKey
    .split(",")
    .filter(Boolean)
    .map((s) => {
      const [a, b] = s.split("-").map(Number);
      return { start: a, end: b };
    });

  const one = (t: Token): React.ReactNode => {
    if (!t.word) return <span key={`t${t.start}`}>{t.text}</span>;
    // 兜底：链接里包住的公式 token（主循环已把公式整体走 InlineMath，
    // 这里只处理「链接与公式区间重叠」的病理 markup）——不可点、弱化样式
    if (mathRanges.some((r) => t.start >= r.start && t.end <= r.end)) {
      return (
        <span key={`t${t.start}`} className="rf-i-math">
          {t.text}
        </span>
      );
    }
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
    // 公式优先于链接：区间整体交给 InlineMath（含隐藏原文，坐标不漂移）
    const mr = mathRanges.find((r) => t.end > r.start && t.start < r.end);
    if (mr) {
      const latex = p.content.slice(mr.start, mr.end);
      // tokenize 把非词字符合并成段（如 " \"、") "），会跨公式边界：
      // 跨界 token 的公式外部分必须照常渲染，否则字符从 DOM 里丢掉、
      // 该公式之后所有词的偏移整体错位
      if (t.start < mr.start) {
        out.push(<span key={`mp${t.start}`}>{t.text.slice(0, mr.start - t.start)}</span>);
      }
      let j = i;
      while (j < tokens.length && tokens[j].start < mr.end) j++;
      out.push(<InlineMath key={`m${mr.start}`} latex={latex} start={mr.start} end={mr.end} />);
      const lastT = tokens[j - 1];
      if (lastT && lastT.end > mr.end) {
        out.push(
          <span key={`mq${mr.end}`}>{lastT.text.slice(mr.end - lastT.start)}</span>,
        );
      }
      i = j;
      continue;
    }
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
    case "math": {
      // KaTeX 纯函数渲染：SSR 与客户端输出一致，无 hydration 风险。
      // content 是 LaTeX 源，不生成可点词；innerHTML 由 KaTeX 生成（XSS 安全模式）。
      const html = renderMath(p.content, meta.display ?? true);
      if (!html) return <pre {...pid} className="rf-pre" data-label="公式"><code>{p.content}</code></pre>;
      return (
        <div
          {...pid}
          className={`rf-math${meta.display === false ? " rf-math-inline-block" : ""}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    case "figure":
      return <FigureBlock p={p} pid={pid} />;
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

/** 配图块：渲染真图；加载失败（防盗链 / 失效）先走服务端代理，仍失败才退回占位文字 */
const FigureBlock = memo(function FigureBlock({ p, pid }: { p: Para; pid: ReturnType<typeof pidProps> }) {
  const meta = p.blockMeta ?? {};
  const src = typeof meta.src === "string" ? meta.src : undefined;
  const [stage, setStage] = useState<"direct" | "proxy">("direct");
  const [broken, setBroken] = useState(false);
  // 只接受 http(s) 绝对地址与 data:image/ 内联图：javascript: 之类没有理由进 <img>
  const safe = Boolean(
    src &&
      (/^https?:\/\//i.test(src) ||
        /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif|bmp)/i.test(src)),
  );
  // data: 内联图不存在防盗链，不需要代理重试
  const canProxy = Boolean(src && /^https?:\/\//i.test(src));
  const shownSrc = stage === "proxy" && src ? `/api/img?u=${encodeURIComponent(src)}` : src;

  if (!safe || broken) {
    return (
      <figure {...pid} className="rf-figure rf-figure-fallback">
        <figcaption>
          {broken ? "图片未能加载：" : ""}
          {p.content || meta.alt || "图片"}
          {safe && canProxy && (
            <>
              （
              <a href={src} target="_blank" rel="noreferrer" className="rf-inline-link">
                查看原图
              </a>
              ）
            </>
          )}
        </figcaption>
      </figure>
    );
  }

  return (
    <figure {...pid} className="rf-figure">
      <img
        src={shownSrc}
        alt={p.content || meta.alt || ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          // 直连失败（防盗链校验 Referer / 403 / 404）→ 换服务端代理再试一次
          if (stage === "direct" && canProxy) setStage("proxy");
          else setBroken(true);
        }}
      />
      {p.content.trim() && <figcaption>{p.content}</figcaption>}
    </figure>
  );
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

  // 用 ref 拿最新的批注列表，避免回看 / 复用释义时闭包停在弹层打开时的快照。
  const annotationsRef = useRef<Annotation[]>(annotations);
  // 本次会话里「这个锚点已经生成过 AI 释义」的内存索引。
  // 服务端落库是唯一事实来源，这里只负责消除「刚写完、列表还没刷新回来」的窗口，
  // 让紧接着点回同一个词也能立刻看到答案、不会又发一次 /api/explain。
  const glossCacheRef = useRef<Map<string, string>>(new Map());
  const anchorKey = (pid: string, start: number, end: number) => `${pid}:${start}:${end}`;
  useEffect(() => {
    annotationsRef.current = annotations;
    for (const a of annotations) {
      if (a.aiGloss) glossCacheRef.current.set(anchorKey(a.paragraphId, a.start, a.end), a.aiGloss);
    }
  }, [annotations]);

  /** 这个锚点是否已经存过 AI 释义（内存索引优先，批次列表兜底） */
  function savedGlossFor(pid: string, start: number, end: number): string | undefined {
    return (
      glossCacheRef.current.get(anchorKey(pid, start, end)) ??
      annotationsRef.current.find(
        (a) => a.paragraphId === pid && a.start === start && a.end === end,
      )?.aiGloss ??
      undefined
    );
  }

  /** 删词 / 删批注后抹掉内存索引，避免「已经删掉的词」还摊开旧答案 */
  function forgetGloss(opts: { wordId?: string; quote?: string }) {
    for (const a of annotationsRef.current) {
      const hit =
        (opts.wordId ? a.wordId === opts.wordId : false) ||
        (opts.quote ? a.quote.trim().toLowerCase() === opts.quote.toLowerCase() : false);
      if (hit) glossCacheRef.current.delete(anchorKey(a.paragraphId, a.start, a.end));
    }
  }

  // 场景 4：同一句里连续请教的次数 + 历史。只放内存、不落库——「这句卡了三次」是
  // 阅读会话内的瞬时状态，不该变成被永久记住的用户数据。
  // key 用「段落 + 句子区间」：换句自动归零，翻页/刷新随组件重挂载清零。
  // history 记录每次选区的原文（不存 AI 生成内容），让模型判断是并列卡点还是同词复用。
  const sentenceAskRef = useRef<{
    key: string;
    count: number;
    history: { selection: string }[];
  }>({ key: "", count: 0, history: [] });

  function noteSelection(
    sig: SelectionSignals,
    paragraphId: string,
    selection: string,
  ): { count: number; priorAsks: { selection: string }[] } {
    const key = `${paragraphId}:${sig.sentenceStart}:${sig.sentenceEnd}`;
    const cur = sentenceAskRef.current;
    if (cur.key === key) {
      // 先取 priorAsks（不含本次），再把本次选区推入历史
      const priorAsks = [...cur.history];
      cur.history.push({ selection });
      cur.count += 1;
      return { count: cur.count, priorAsks };
    }
    const history = [{ selection }];
    sentenceAskRef.current = { key, count: 1, history };
    return { count: 1, priorAsks: [] };
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
  // 连续点两个词会并发发两次请求；旧的响应晚到会覆盖掉含新批注的列表，
  // 于是「AI 释义找不到该写回哪条」变成偶发问题。用序号丢弃过期响应。
  const annotSeq = useRef(0);
  const loadAnnotations = useCallback(async () => {
    const seq = ++annotSeq.current;
    try {
      const res = await fetch(`/api/annotations?textId=${encodeURIComponent(textId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== annotSeq.current) return;
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

  // 定位到目标段落（词库「跳到原文」的 ?p=，或按 read_idx 自动续读）。
  // 以前会加 .para-flash 让整段标绿 2.4 秒再消失；那种一闪而过的反馈太突兀，
  // 按用户要求去掉。滚动到位本身就是定位反馈，不再叠任何颜色动画。
  useEffect(() => {
    if (!focusParaId) return;
    const el = document.querySelector(`[data-pid="${focusParaId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
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
    const askInfo = noteSelection(sig, pid, displayForm);
    const pickData: Pick = {
      paragraphId: pid,
      paragraphIdx: p.idx,
      anchor: buildAnchor(p.content, s, en),
      x: rect.left + rect.width / 2,
      y: rect.bottom,
      source: "word",
      signals: {
        ...sig,
        repeatCount: askInfo.count,
        ...(askInfo.priorAsks.length > 0 ? { priorAsks: askInfo.priorAsks } : {}),
      },
    };
    // 同一个锚点之前问过 AI：直接把答案摊开，不再重新请求模型。
    // 这也是「点回已经变绿的词」时能立刻看到那次解释的依据。
    const cached = savedGlossFor(pid, pickData.anchor.start, pickData.anchor.end);
    if (cached) {
      pickData.initialGloss = cached;
      pickData.fromAnnotation = true;
    }
    markActiveAnchor([wordEl]);
    setPick(pickData);

    if (!autoSave) return;
    // ⚠️ savedMap 是**全量词库**，不是「本文这一处有没有批注」。
    // 以前这里写 `if (savedMap.get(key)) return`，结果一个词在别的文章收过，
    // 在当前文章再点就既不建 context 也不刷新列表 —— 绿色 ✓ 有了，
    // 「已存批注」里却永远找不到它。
    //
    // 也别拿前端 annotations 快照做「这一处已有批注就跳过」的乐观判断：
    // delete-on-deselect 刚删过词、并发刷新、别处补建 context 都会让快照过期，
    // 一跳过就既拿不到 justSaved（撤销按钮消失），也漏掉这一处的 context。
    // /api/contexts/ensure 本身按锚点幂等，重复点只是多一次 SELECT，
    // 落库裁决统一交给服务端，前端不猜。
    void ensureAnnotation(pickData);
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

    const start = offsetIn(pEl, range.startContainer, range.startOffset, "start");
    const end = offsetIn(pEl, range.endContainer, range.endOffset, "end");
    if (end <= start) return;

    // 拖选：批注卡直接进右栏（不再用鼠标旁浮层）
    const anchors = [...pEl.querySelectorAll<HTMLElement>(".w")].filter((el) => {
      const s = Number(el.dataset.s);
      const en = Number(el.dataset.e);
      return en > start && s < end;
    });
    markActiveAnchor(anchors);
    const sig = selectionSignals(p.content, start, end, "select");
    const selectionText = p.content.slice(start, end).trim();
    const askInfo = noteSelection(sig, pid, selectionText);
    const pickData: Pick = {
      paragraphId: pid,
      paragraphIdx: p.idx,
      anchor: buildAnchor(p.content, start, end),
      x: e.clientX,
      y: e.clientY,
      source: "select",
      signals: {
        ...sig,
        repeatCount: askInfo.count,
        ...(askInfo.priorAsks.length > 0 ? { priorAsks: askInfo.priorAsks } : {}),
      },
    };
    const cached = savedGlossFor(pid, pickData.anchor.start, pickData.anchor.end);
    if (cached) {
      pickData.initialGloss = cached;
      pickData.fromAnnotation = true;
    }
    setPick(pickData);

    // 与点词一致：自动收词开时，拖选的句子/短语也自动入库。
    // 关掉批注后仍能从「已存批注」翻回去看，不用重新选中。
    if (autoSave && /\s/.test(pickData.anchor.quote.trim())) {
      void ensureAnnotation(pickData);
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

  /**
   * 自动批注：确保「本文这一处」有一条 context（按锚点幂等）。
   *
   * 与手动收词 saveWord() 不同：后者总是新插一条 context，这里由服务端
   * `ensureContextByAnchor()` 裁决，重复点同一个位置不会堆重复批注。
   * 词在别的文章收过时 user_words 只是 upsert，不会新建一个词条，
   * 但当前文章这一处仍会得到自己的批注 —— 「已收词」和「已存批注」终于对齐。
   */
  async function ensureAnnotation(pickData: Pick): Promise<SavedWordInfo | null> {
    const { anchor, paragraphId } = pickData;
    try {
      const res = await fetch("/api/contexts/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          word: anchor.quote,
          quote: anchor.quote,
          textId,
          paragraphId,
          start: anchor.start,
          end: anchor.end,
          prefix: anchor.prefix || "",
          suffix: anchor.suffix || "",
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
      if (data.created) {
        setSavedMap((prev) => {
          const next = new Map(prev);
          next.set(info.displayForm.toLowerCase(), info);
          if (info.lemma) next.set(info.lemma.toLowerCase(), info);
          return next;
        });
      }
      setPick((cur) =>
        cur &&
        cur.paragraphId === paragraphId &&
        cur.anchor.start === anchor.start &&
        cur.anchor.end === anchor.end
          ? {
              ...cur,
              // 只有本次真新建了词条才允许「收起即撤销」，别误删老词
              justSaved: data.created === true,
              contextId: data.contextId ?? cur.contextId,
            }
          : cur,
      );
      if (data.contextCreated) {
        celebrate(
          pickData.x,
          pickData.y - 20,
          data.created && !/\s/.test(anchor.quote.trim()) ? "+1 词" : "+1 批注",
        );
      }
      await loadAnnotations();
      return info;
    } catch {
      return null;
    }
  }

  /**
   * AI 释义生成完成后回填到批注，翻回去看时不用重新请求 AI。
   *
   * 关键改动：只把「锚点 + 释义全文」交给服务端，不再要求前端先拿到 contextId。
   * 旧实现在找不到 context 时静默 return —— 自动收词关闭、词在别的文章里收过、
   * 或两次并发请求竞态时，答案就「看得见、存不下」。现在由 /api/contexts/gloss
   * 按锚点更新或补建，把「点了 AI 就一定能查到」变成服务端保证的契约。
   *
   * pickData 用弹层打开那一帧的对象（锚点稳定），即使中途切到别的词，
   * 迟到的流式结果也只会写回它自己那次选区。
   */
  async function persistGloss(pickData: Pick, gloss: string) {
    const { anchor, paragraphId } = pickData;
    try {
      const res = await fetch("/api/contexts/gloss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          word: anchor.quote,
          quote: anchor.quote,
          textId,
          paragraphId,
          start: anchor.start,
          end: anchor.end,
          prefix: anchor.prefix || "",
          suffix: anchor.suffix || "",
          aiGloss: gloss,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();

      // 先把结果放进内存索引：紧接着点回同一个词也能立刻看到，不必等列表刷新。
      glossCacheRef.current.set(
        anchorKey(paragraphId, anchor.start, anchor.end),
        gloss,
      );
      // 服务端补建了词条（例如词在别的文章收过、自动收词关闭），同步 ✓/+ 状态
      if (data.created) {
        const info: SavedWordInfo = {
          id: data.wordId,
          lemma: data.lemma ?? "",
          displayForm: data.displayForm ?? anchor.quote,
          translation: data.translation ?? "",
          status: data.status ?? "learning",
          starred: data.starred ?? 0,
        };
        setSavedMap((prev) => {
          const next = new Map(prev);
          next.set(info.displayForm.toLowerCase(), info);
          if (info.lemma) next.set(info.lemma.toLowerCase(), info);
          return next;
        });
      }
      // 当前仍停在同一锚点时把 contextId 挂回去，供收词按钮 / 高亮使用
      if (data.contextId) {
        setPick((cur) =>
          cur &&
          cur.paragraphId === paragraphId &&
          cur.anchor.start === anchor.start &&
          cur.anchor.end === anchor.end
            ? { ...cur, contextId: data.contextId }
            : cur,
        );
      }
      await loadAnnotations();
    } catch {
      /* 静默失败：释义已经在卡片上展示，不影响继续阅读 */
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
      fromAnnotation: true,
      initialGloss: savedGlossFor(a.paragraphId, a.start, a.end) ?? a.aiGloss ?? undefined,
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
    forgetGloss({ wordId: a.wordId });
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
    forgetGloss({ quote: key });
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
    forgetGloss({ wordId: id });
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

  /** 没配模型时服务端返回的是引导文案：给重试入口，别把它当答案，也不写回批注 */
  const needsSetup = aiStatus === "done" && isNotAGloss(aiText);

  // 是短语（含空格）还是单词
  const isPhrase = /\s/.test(anchor.quote.trim());

  /** 这个弹层会不会在词典查不到时自动问老师（用于文案，也用于避免误导） */
  const autoExplain = shouldAutoExplain({
    dictHit: Boolean(dict?.entry),
    hasInitialGloss: Boolean(initialGloss),
    fromAnnotation: Boolean(pick.fromAnnotation),
  });

  // 弹层打开时自动查词典；查不到就顺着第 2 层直接开始 AI 释义。
  // 自动触发挂在 fetch 回调里而不是一个「看 dict state」的 effect：
  // 组件复用时 state 会短暂残留上一次的结果，只有请求自己确认「这次没命中」才可靠。
  useEffect(() => {
    setDict(null);
    setDictLoading(true);
    setAiText(initialGloss ?? "");
    setAiStatus(initialGloss ? "done" : "idle");
    setShowAskInput(false);
    setAskPrompt("");
    setForceWordMode(false);

    // 选区切换后，旧请求的回调不能再替新的选区发起 AI 请求
    let cancelled = false;

    fetch(`/api/dict?word=${encodeURIComponent(anchor.quote)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setDict(data);
        setDictLoading(false);
        if (
          shouldAutoExplain({
            dictHit: Boolean(data?.entry),
            hasInitialGloss: Boolean(initialGloss),
            fromAnnotation: Boolean(pick.fromAnnotation),
          })
        ) {
          // 词典给不出答案：用户已经停下来请教了，别再让他多点一次按钮。
          // 此时 dict state 还是 null，triggerAI() 里算出的 dictHit=false 正是实情。
          void triggerAI();
        }
      })
      .catch(() => {
        if (!cancelled) setDictLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [anchor.quote, initialGloss]);

  /** 触发 AI 释义（流式）。forceWord = 把「按整句分析」临时改回按词回答。 */
  async function triggerAI(prompt?: string, forceWord = false) {
    setAiStatus("loading");
    setAiText("");

    // 客观信号：前端只采集证据，不下结论。词典命中在这里补（构造 Pick 时还没查词典）。
    // forceWord = 用户点了「改按词答」，把 repeatCount/priorAsks 清零，让模型按第 1 次的深度走。
    const signals = pick.signals
      ? {
          ...pick.signals,
          dictHit: Boolean(dict?.entry),
          ...(forceWord ? { repeatCount: 0, priorAsks: undefined } : {}),
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
      // 生成完成即写回该批注，翻回去看时不用重新请求 AI。
      // 但「没配模型」的引导文案 / 报错文案不是释义，存进去会被当成已存释义展示。
      if (!isNotAGloss(text)) onAIGloss?.(text);
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
              onClick={() =>
                onSave(aiStatus === "done" && !isNotAGloss(aiText) ? aiText : undefined)
              }
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
          {isPhrase ? "短语不在词典中" : "词典未收录"} ·{" "}
          {autoExplain ? "交给 AI 老师解释" : "可用 AI 解释"}
        </p>
      )}

      {/* 新选区在词典未命中时已自动触发；这个手动入口留给回看旧批注 / 请求失败重试 */}
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
            {aiStatus === "error" && (
              <button className="rf-ask-mini" onClick={() => void triggerAI()}>
                重试
              </button>
            )}
            {needsSetup && (
              <button className="rf-ask-mini" onClick={() => void triggerAI()}>
                配置好模型后重试
              </button>
            )}
            {aiStatus === "done" && !needsSetup && !showAskInput && (
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


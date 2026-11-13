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
import { inlineGloss } from "@/lib/gloss";
import { parseThread, serializeThread, type ThreadTurn } from "@/lib/ai-thread";
import { findCoveringRange } from "@/lib/annotation-range";
import { renderMath } from "@/lib/math";
import MarkdownText from "@/components/MarkdownText";
import type { AskKind, Feedback } from "@/lib/learner/types";
import { LEARNER_CHANGED_EVENT } from "@/lib/settings-form";

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
  /** 来源：点词 or 拖选 */
  source: "word" | "select";
  /** 这一处记录（context）的 id：落库后才有，「取消记录」按钮要用 */
  contextId?: string;
  /** 记录所属词条 id：「取消记录」按它删本文这一处 */
  wordId?: string;
  /** 点回正文里已存的记录（绿色划线）：回看，不查词典、不自动问 AI */
  fromAnnotation?: boolean;
  /** 回看时直接展示当时保存的 AI 释义 */
  initialGloss?: string;
  /** 回看时直接展示当时保存的词典结果快照（null = 当时词典没收录） */
  initialDict?: DictResult | null;
  /** 这次选区采集的客观信号，随 /api/explain 送给模型（不是结论） */
  signals?: SelectionSignals;
};

/** 右栏 AI 对话串里的一段（P26） */
type AskReq = {
  /** 问题标题（显示为「你问：…」）；默认讲解为空 */
  ask?: string;
  /** 送给模型的具体问题 */
  prompt?: string;
  /** 整句提问时送给模型的选区（整句原文） */
  word?: string;
  wholeSentence?: boolean;
  /** 把同句加深清零，只讲这个词 */
  forceWord?: boolean;
  /** P32：这次讲解的种类，随 /api/explain 送给服务端记事件 */
  askKind?: AskKind;
};
type Turn = ThreadTurn & {
  status: "loading" | "streaming" | "done" | "error";
  req?: AskReq;
  /** P32：这段回答的 id（X-RF-Answer-Id），回看历史时没有 */
  answerId?: string;
  feedback?: Feedback;
  feedbackError?: string;
};

function turnsFrom(raw: string | null | undefined): Turn[] {
  return parseThread(raw).map((t) => ({ ...t, status: "done" as const }));
}

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
  /** P23 行内标签：词典命中时中文从这里来（/api/annotations 随批注下发） */
  translation: string | null;
  /** 查词当时的词典结果快照（P25）：回看直接用，不再查词典 */
  dict: DictResult | null;
  createdAt: number;
};

function paraOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  return el?.closest<HTMLElement>("[data-pid]") ?? null;
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
 * 坐标层 .rf-math-src 用 display:none 保留 LaTeX 原文，复合体自身带 data-s / data-e。
 * 选词按每个词 span 的 data-s / data-e 取坐标（不读 DOM 文本长度），
 * 所以跨公式选短语、点公式前后的词，锚点坐标与 content 严格一致。
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
      {/* data-rf-skip：渲染视图不是 content 里的字符，MathML 部分留给屏幕阅读器 */}
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
  // rangeKey = "已存批注区间,...|当前选中区间|拖动预览区间|悬停的批注区间"：
  // 四种样式都由渲染决定，不命令式改 DOM class（重渲染会把手动加的 class 冲掉）。
  // 第 4 段让「悬停到短语里某个词」时整条批注一起亮，而不是只亮那一个词。
  const [annKey, anchorKey = "", dragKey = "", hoverKey = ""] = rangeKey.split("|");
  // P23：批注区间后面可跟 ":短释义"（encodeURIComponent 过，不会撞 , | - 分隔符）。
  // 短释义只用来给区间左端 span 生成 CSS 伪元素，绝不作为文本节点插进 DOM。
  const parseRanges = (k: string) =>
    k
      .split(",")
      .filter(Boolean)
      .map((s) => {
        const [range, gloss = ""] = s.split(":");
        const [a, b] = range.split("-").map(Number);
        return { start: a, end: b, gloss: gloss ? decodeURIComponent(gloss) : "" };
      });
  const annotatedRanges = parseRanges(annKey);
  const anchor = parseRanges(anchorKey)[0];
  const dragSel = parseRanges(dragKey)[0];
  const hoverSel = parseRanges(hoverKey)[0];

  /** 一条连续底色的 class：区间内 + 两端圆角标记 */
  const runCls = (t: Token, word: boolean, list: { start: number; end: number }[], name: string) => {
    const hit = list.filter((r) =>
      word ? t.end > r.start && t.start < r.end : t.start >= r.start && t.end <= r.end,
    );
    if (hit.length === 0) return [];
    const out = [name];
    if (word && hit.some((r) => t.start <= r.start)) out.push(`${name}-l`);
    if (word && hit.some((r) => t.end >= r.end)) out.push(`${name}-r`);
    return out;
  };
  const anchorList = anchor ? [anchor] : [];
  const dragList = dragSel ? [dragSel] : [];
  const hoverList = hoverSel ? [hoverSel] : [];

  const one = (t: Token): React.ReactNode => {
    if (!t.word) {
      // 词间空白 / 标点也带坐标（.rf-g）：批注、选中、拖选的底色要把它们一起涂上，
      // 否则一个短语会被涂成「defined」「an」「ultraintelligent」一块块断开的样子。
      // 只在完整落在某个批注区间内部时才涂（首尾的空格、引号不算进去）。
      const gapCls = [
        "rf-g",
        ...runCls(t, false, annotatedRanges, "w-annotated"),
        ...runCls(t, false, anchorList, "w-anchor"),
        ...runCls(t, false, dragList, "w-drag"),
        ...runCls(t, false, hoverList, "w-ann-hover"),
      ].join(" ");
      return (
        <span
          key={`t${t.start}`}
          className={gapCls}
          data-s={t.start}
          data-e={t.end}
        >
          {t.text}
        </span>
      );
    }
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
    // 一整条底色只在两端圆角，中间与词间空白直角相接，看起来是连续的一条
    const cls = [
      "w",
      ...runCls(t, true, annotatedRanges, "w-annotated"),
      ...runCls(t, true, anchorList, "w-anchor"),
      ...runCls(t, true, dragList, "w-drag"),
      ...runCls(t, true, hoverList, "w-ann-hover"),
      styleClassesFor(t, ranges),
    ]
      .filter(Boolean)
      .join(" ");
    // 行内中文标签只挂在批注区间的左端词上（.w-annotated-l 就是那个词）。
    // 属性 + CSS 伪元素生成，data-s/data-e 与可见文本节点一个字都不变。
    const gloss = annotatedRanges.find(
      (r) => r.gloss && t.start <= r.start && t.end > r.start && t.start < r.end,
    )?.gloss;
    return (
      <span
        key={`t${t.start}`}
        className={cls}
        data-s={t.start}
        data-e={t.end}
        data-gloss={gloss || undefined}
      >
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
  /** P32 F5：反馈行受「本人开关 + 站点开关」双重控制 */
  const [feedbackEnabled, setFeedbackEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void fetch("/api/learner")
        .then((r) => r.json())
        .then((d: { showFeedback?: boolean; personalized?: boolean }) => {
          if (alive) setFeedbackEnabled(d.showFeedback !== false && d.personalized !== false);
        })
        .catch(() => { /* 读不到就不显示反馈行，不影响阅读 */ });
    };
    refresh();
    // 设置弹窗关闭 / 「学习档案」里改动开关后立刻重读，不用刷新页面。
    // 以前只在挂载时读一次，关掉反馈行要等到下次打开文章才生效。
    window.addEventListener(LEARNER_CHANGED_EVENT, refresh);
    return () => {
      alive = false;
      window.removeEventListener(LEARNER_CHANGED_EVENT, refresh);
    };
  }, []);
  /** 拖动中的预览范围（按下即整词）；松手清空 */
  const [dragSel, setDragSel] = useState<{ pid: string; start: number; end: number } | null>(null);
  const [floats, setFloats] = useState<{ id: number; x: number; y: number; text: string }[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  /** 悬停命中的已存批注区间：短语里的几个词属于同一条批注，整条一起亮 */
  const [hoverAnn, setHoverAnn] = useState<{
    paragraphId: string;
    start: number;
    end: number;
    id: string;
  } | null>(null);
  const hoverAnnRef = useRef<string | null>(null);
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

  /** 这个词落在哪条已存批注里：多条重叠时取区间最短、起点最早的一条 */
  function findCoveringAnnotation(pid: string, s: number, en: number): Annotation | undefined {
    return findCoveringRange(annotationsRef.current, pid, s, en);
  }

  /** 由一条已存记录构造回看用的 Pick：词典快照 + AI 释义都直接带进右栏 */
  function recallPick(a: Annotation, rect: { left: number; width: number; bottom: number }): Pick {
    return {
      paragraphId: a.paragraphId,
      paragraphIdx: a.paragraphIdx,
      anchor: { start: a.start, end: a.end, quote: a.quote, prefix: a.prefix, suffix: a.suffix },
      x: rect.left + rect.width / 2,
      y: rect.bottom,
      source: /\s/.test(a.quote.trim()) ? "select" : "word",
      contextId: a.id,
      wordId: a.wordId,
      fromAnnotation: true,
      initialGloss: a.aiGloss ?? savedGlossFor(a.paragraphId, a.start, a.end) ?? undefined,
      initialDict: a.dict,
    };
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

  // 场景 4：同一句里请教过几次、问过哪些选区（P26 重写）。
  // 旧版只在内存里记「最近一句」：在 A 句查一个词、去 B 句查一个、再回 A 句就从 1 重数，
  // 刷新页面也清零 —— 逐级加深经常不生效。现在以「这句里已经存下的记录」为准
  // （P23 起每次查词都落库，刷新、跨句来回都不丢），再并上本次会话里还没落库的那几次。
  // 只记选区原文，不存 AI 生成内容，让模型判断是并列卡点还是同词复用。
  const sentenceAskRef = useRef<Map<string, string[]>>(new Map());

  function noteSelection(
    sig: SelectionSignals,
    paragraphId: string,
    selection: string,
  ): { count: number; priorAsks: { selection: string }[] } {
    const key = `${paragraphId}:${sig.sentenceStart}:${sig.sentenceEnd}`;
    const norm = (x: string) => x.trim().toLowerCase();
    const mine = norm(selection);
    const saved = annotationsRef.current
      .filter(
        (a) =>
          a.paragraphId === paragraphId &&
          a.start >= sig.sentenceStart &&
          a.end <= sig.sentenceEnd,
      )
      .map((a) => a.quote.trim());
    const session = sentenceAskRef.current.get(key) ?? [];
    const prior: string[] = [];
    for (const q of [...saved, ...session]) {
      if (norm(q) !== mine && !prior.some((p) => norm(p) === norm(q))) prior.push(q);
    }
    sentenceAskRef.current.set(key, [...session.filter((q) => norm(q) !== mine), selection]);
    return { count: prior.length + 1, priorAsks: prior.map((q) => ({ selection: q })) };
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
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `请求失败（${res.status}）`);
      }

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

  /** 拉取本文已保存的句子/短语批注：正文绿色标记与 AI 释义缓存的唯一数据源 */
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
      /* 静默失败：标记与释义缓存是增强功能，不影响正文阅读 */
    }
  }, [textId]);

  useEffect(() => {
    void loadAnnotations();
  }, [loadAnnotations]);

  /** 关闭右侧批注：清空选区 + 去掉正文锚点高亮 */
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
  const anchorPid = pick?.paragraphId;
  const anchorStart = pick?.anchor.start;
  const anchorEnd = pick?.anchor.end;
  const rangeKeyByPara = useMemo(() => {
    const annByPara = new Map<string, string>();
    for (const a of annotations) {
      // P23：短释义跟着区间一起编码进 key。AI 释义写回后 gloss 变化 → 该段 key 变化
      // → 只有这一段重渲染，长文其余段落不受影响（memo 化机制不变）。
      const g = encodeURIComponent(inlineGloss(a.aiGloss, a.translation));
      annByPara.set(
        a.paragraphId,
        (annByPara.get(a.paragraphId) ?? "") + `${a.start}-${a.end}:${g},`,
      );
    }
    // 四段统一格式：已存批注(含短释义) | 当前选中 | 拖动预览 | 悬停的批注区间。
    // 只有涉及的那一段落 key 会变，其它段落字符串不变 → memo 块不重渲染。
    const pids = new Set(annByPara.keys());
    if (anchorPid) pids.add(anchorPid);
    if (dragSel) pids.add(dragSel.pid);
    if (hoverAnn && !dragSel) pids.add(hoverAnn.paragraphId);
    const m = new Map<string, string>();
    for (const pid of pids) {
      const ann = annByPara.get(pid) ?? "";
      const anchorPart =
        !dragSel && pid === anchorPid && anchorStart !== undefined && anchorEnd !== undefined
          ? `${anchorStart}-${anchorEnd}`
          : "";
      const dragPart = dragSel && pid === dragSel.pid ? `${dragSel.start}-${dragSel.end}` : "";
      const hoverPart =
        hoverAnn && !dragSel && pid === hoverAnn.paragraphId
          ? `${hoverAnn.start}-${hoverAnn.end}`
          : "";
      m.set(pid, `${ann}|${anchorPart}|${dragPart}|${hoverPart}`);
    }
    return m;
  }, [annotations, anchorPid, anchorStart, anchorEnd, dragSel, hoverAnn]);

  // 分组是纯函数（服务端/客户端结果一致），不会引入 hydration 差异
  const groups = useMemo(
    () => groupBlocks(paragraphs.filter((p) => !isSkipped(p))),
    [paragraphs],
  );

  /**
   * 选中一个词：单击，或按下后没离开这个词就松开。
   * 再点同一个词 = 收起（本次自动新建的词随之撤销）。
   */
  function pickWord(wordEl: HTMLElement) {
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

    // 点在已存的记录上（单词或短语的绿色划线）：回看，一次请求都不发 ——
    // 右栏直接摊开当时存下的词典结果和 AI 释义（P25）。点短语里的某个词也回看整条：
    // 往往是当初那条答案没把这个词讲清楚，不是「又查一个新词」。
    // 再点一次正在看的这条 = 收起右栏；点词永远不删除记录，删除只走「取消记录」按钮。
    const covering = findCoveringAnnotation(pid, s, en);
    if (covering) {
      if (pick?.contextId === covering.id) close();
      else setPick(recallPick(covering, rect));
      return;
    }
    // 记录还在落库途中（批注列表没刷新）就又点了同一个词：同样只是收起
    if (pick && pick.paragraphId === pid && pick.anchor.start === s && pick.anchor.end === en) {
      close();
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
    setPick(pickData);

    // P23：自动收词开关已移除，点词一律落库 —— 「查过 = 已有批注 = 显示行内中文标签」。
    // ⚠️ savedMap 是**全量词库**，不是「本文这一处有没有批注」。
    // 以前这里写 `if (savedMap.get(key)) return`，结果一个词在别的文章收过，
    // 在当前文章再点就既不建 context 也不刷新列表 —— 绿色 ✓ 有了，
    // 「已存批注」里却永远找不到它。
    //
    // 也别拿前端 annotations 快照做「这一处已有批注就跳过」的乐观判断：
    // delete-on-deselect 刚删过词、并发刷新、别处补建 context 都会让快照过期，
    // 一跳过就漏掉这一处的 context，「取消记录」按钮也拿不到 contextId。
    // /api/contexts/ensure 本身按锚点幂等，重复点只是多一次 SELECT，
    // 落库裁决统一交给服务端，前端不猜。
    void ensureAnnotation(pickData);
  }

  /** 选中一段：按下后拖过两个及以上的词（[start, end) 已经是整词边界） */
  function pickRange(pEl: HTMLElement, start: number, end: number, x: number, y: number) {
    const pid = pEl.dataset.pid!;
    const p = paragraphs.find((x) => x.id === pid);
    if (!p) return;

    // 划的正好是一条已存记录：回看，不重新查
    const same = annotationsRef.current.find(
      (a) => a.paragraphId === pid && a.start === start && a.end === end,
    );
    if (same) {
      const r = pEl.getBoundingClientRect();
      setPick(recallPick(same, { left: x, width: 0, bottom: y || r.top }));
      return;
    }

    // 拖选：批注卡直接进右栏（不再用鼠标旁浮层）
    const sig = selectionSignals(p.content, start, end, "select");
    const selectionText = p.content.slice(start, end).trim();
    const askInfo = noteSelection(sig, pid, selectionText);
    const pickData: Pick = {
      paragraphId: pid,
      paragraphIdx: p.idx,
      anchor: buildAnchor(p.content, start, end),
      x,
      y,
      source: "select",
      signals: {
        ...sig,
        repeatCount: askInfo.count,
        ...(askInfo.priorAsks.length > 0 ? { priorAsks: askInfo.priorAsks } : {}),
      },
    };
    setPick(pickData);

    // 与点词一致（P23 起不再有开关）：拖选的句子/短语也自动入库。
    // 关掉批注后仍能点正文的绿色标记翻回去看，不用重新选中。
    if (/\s/.test(pickData.anchor.quote.trim())) {
      void ensureAnnotation(pickData);
    }
  }

  // 原生事件监听只挂一次，闭包里的 pick 会过期：每次渲染后把最新的处理函数放进 ref
  const pickRef = useRef({ pickWord, pickRange });
  useEffect(() => {
    pickRef.current = { pickWord, pickRange };
  });

  // ---- 选词交互（对齐 Readlang）----
  // 不用浏览器原生选区：原生选区按字符走，从「defined」的 d 后面按下，高亮就从 e 开始。
  // 改成在词上按下时阻止原生选区、立刻整词选中；拖动时取指针下的词，起点词到当前词
  // 之间整词连成一条（.w-drag）；拖出起点段落就停在段首 / 段尾。松手：没离开起点词
  // = 点词，否则 = 选短语。按住 Option（⌥）拖动则交还原生选区，用来复制原文。
  const suppressClickRef = useRef(false);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    type Drag = { pEl: HTMLElement; words: HTMLElement[]; from: number; to: number };
    let drag: Drag | null = null;

    const rangeOf = (d: Drag) => {
      const a = Math.min(d.from, d.to);
      const b = Math.max(d.from, d.to);
      return { start: Number(d.words[a].dataset.s), end: Number(d.words[b].dataset.e) };
    };
    // 预览走 React 渲染（只重渲染这一段）：命令式改 class 会被同时到来的重渲染冲掉，
    // 比如刚打开页面时批注列表返回，按下的那个词就不亮了
    const paint = (d: Drag) => {
      const r = rangeOf(d);
      setDragSel({ pid: d.pEl.dataset.pid ?? "", start: r.start, end: r.end });
    };

    /**
     * 离指针最近的词。正文行高约是字高的 1.4 倍，行与行之间有一条不属于任何词的空白
     * （约占正文三分之一的高度）。按在这里时浏览器会起原生选区（蓝色、按字符走），
     * 所以段内任何位置都按「先找最近的一行、再找这一行里水平最近的词」吸附到整词。
     */
    function nearestWord(words: HTMLElement[], x: number, y: number) {
      let best = { i: -1, dx: Infinity, dy: Infinity };
      let bestScore = Infinity;
      words.forEach((w, i) => {
        for (const r of w.getClientRects()) {
          const dy = Math.max(r.top - y, 0, y - r.bottom);
          const dx = Math.max(r.left - x, 0, x - r.right);
          const score = dy * 10000 + dx;
          if (score < bestScore) {
            bestScore = score;
            best = { i, dx, dy };
          }
        }
      });
      return best;
    }
    /** 按下时只在「贴着词」的空白里吸附（行间、词间）；点行尾远处的空白是想收起卡片，不选词 */
    const SNAP_PX = 14;

    /** 拖动中指针对应哪个词：段落上方 / 下方 → 段首 / 段尾；段落范围内 → 最近的词 */
    function wordIndexAt(d: Drag, x: number, y: number): number {
      const w = document.elementFromPoint(x, y)?.closest<HTMLElement>(".w");
      if (w && d.pEl.contains(w)) return d.words.indexOf(w);
      const r = d.pEl.getBoundingClientRect();
      if (y < r.top) return 0;
      if (y > r.bottom) return d.words.length - 1;
      const n = nearestWord(d.words, x, y);
      return n.i >= 0 ? n.i : d.to;
    }

    function onDown(e: MouseEvent) {
      if (e.button !== 0 || e.altKey) return; // Option 拖动：走原生选区，方便复制
      const target = e.target as HTMLElement;
      // 代码块、表单控件保持原生行为（代码要能直接选中复制）
      if (target.closest("pre, input, textarea, button")) return;
      // 正文区其余任何位置都不起原生选区：包括段落之间、行与行之间的空白
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      const pEl = paraOf(target);
      if (!pEl) return;
      const words = [...pEl.querySelectorAll<HTMLElement>(".w")];
      if (words.length === 0) return;
      const hit = target.closest<HTMLElement>(".w");
      let i = hit ? words.indexOf(hit) : -1;
      if (i < 0) {
        const n = nearestWord(words, e.clientX, e.clientY);
        if (n.dx <= SNAP_PX && n.dy <= SNAP_PX) i = n.i;
      }
      if (i < 0) return;
      drag = { pEl, words, from: i, to: i };
      body!.classList.add("rf-dragging");
      paint(drag);
    }
    function finish(x: number, y: number) {
      const d = drag;
      drag = null;
      body!.classList.remove("rf-dragging");
      setDragSel(null);
      if (!d) return;
      // 松手后浏览器还会补一个 click：这次已经处理过了，别让 onClick 再处理一遍
      suppressClickRef.current = true;
      setTimeout(() => (suppressClickRef.current = false), 0);
      if (d.from === d.to) {
        pickRef.current.pickWord(d.words[d.from]);
      } else {
        const r = rangeOf(d);
        pickRef.current.pickRange(d.pEl, r.start, r.end, x, y);
      }
    }
    function onMove(e: MouseEvent) {
      if (!drag) return;
      if ((e.buttons & 1) === 0) return finish(e.clientX, e.clientY); // 松手发生在窗口外
      e.preventDefault();
      const i = wordIndexAt(drag, e.clientX, e.clientY);
      if (i !== drag.to) {
        drag.to = i;
        paint(drag);
      }
    }
    function onUp(e: MouseEvent) {
      if (drag) finish(e.clientX, e.clientY);
    }
    body.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      body.removeEventListener("mousedown", onDown);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  /** 词与短语已在 mouseup 里处理；click 只负责「点空白处收起」和挡住链接跳转 */
  function onClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    // 链接里的词：点词优先弹释义，别直接跳走
    if (target.closest(".w") && target.closest("a.rf-inline-link")) e.preventDefault();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // Option 拖动出来的原生选区：留给复制
    if (!target.closest(".w")) close();
  }

  /** 悬停到已存批注里的任意位置：整条区间一起亮（走 rangeKey 渲染，不命令式改 class）。
      用 [data-s] 统一取「词 / 词间空白」，避免鼠标经过短语中间空格时高亮闪一下。 */
  function onBodyMouseOver(e: React.MouseEvent) {
    if (dragSel) return;
    const token = (e.target as HTMLElement).closest<HTMLElement>("[data-s]");
    const pEl = token?.closest<HTMLElement>("[data-pid]");
    if (!token || !pEl?.dataset.pid) {
      clearAnnHover();
      return;
    }
    const ann = findCoveringAnnotation(
      pEl.dataset.pid,
      Number(token.dataset.s),
      Number(token.dataset.e),
    );
    if (!ann) {
      clearAnnHover();
      return;
    }
    if (hoverAnnRef.current === ann.id) return;
    hoverAnnRef.current = ann.id;
    setHoverAnn({ paragraphId: ann.paragraphId, start: ann.start, end: ann.end, id: ann.id });
  }

  function clearAnnHover() {
    if (hoverAnnRef.current === null) return;
    hoverAnnRef.current = null;
    setHoverAnn(null);
  }

  function celebrate(x: number, y: number, label: string) {
    const id = Date.now() + Math.random();
    setFloats((f) => [...f, { id, x, y, text: label }]);
    setTimeout(() => setFloats((f) => f.filter((i) => i.id !== id)), 1200);
  }



  /**
   * 自动批注：确保「本文这一处」有一条 context（按锚点幂等）。
   *
   * 与 POST /api/words 不同：后者总是新插一条 context，这里由服务端
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
              contextId: data.contextId ?? cur.contextId,
              wordId: data.wordId ?? cur.wordId,
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
   * pickData 用弹层打开那一帧的对象（锚点稳定），写回只落到它自己那次选区。
   * 中途切到别的词时，弹层卸载会中止 AI 流，半截答案不会写回。
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

  // 回看入口改为正文的绿色标记：pickWord / pickRange 命中 savedGlossFor 时，
  // 把上次的释义作为 initialGloss 带进 PickCard，右栏直接摊开、不重新请求模型。

  /**
   * 取消记录（P25）：删掉这个词在本文的记录 —— 右栏释义、正文绿色划线、划线上方的
   * 中文一起消失。只删本文这一处；词在别的文章还有记录就保留词条，没有了才连词条一起删
   * （服务端裁决，返回 prunedWord）。
   * 必须刷新批注列表：正文的划线和行内中文都由 annotations 派生，不刷新就是陈旧快照（P24 的教训）。
   */
  async function cancelRecord(target: Pick) {
    const wordId =
      target.wordId ?? annotationsRef.current.find((a) => a.id === target.contextId)?.wordId;
    if (!wordId) return;
    let pruned = false;
    try {
      const res = await fetch(
        `/api/words/${wordId}?textId=${encodeURIComponent(textId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) return;
      pruned = Boolean((await res.json()).prunedWord);
    } catch {
      return;
    }
    forgetGloss({ wordId });
    if (pruned) {
      setSavedMap((prev) => {
        const next = new Map(prev);
        for (const [k, v] of next) if (v.id === wordId) next.delete(k);
        return next;
      });
    }
    setPick((cur) => (cur && cur.contextId === target.contextId ? null : cur));
    await loadAnnotations();
  }

  return (
    <div className="reader-split">
      {/* 左栏（61.8%）：正文 */}
      <div className="reader-main">
        <div className="duo-card reader-article-card">
          <div
            className="reading-body"
            ref={bodyRef}
            onClick={onClick}
            onMouseOver={onBodyMouseOver}
            onMouseLeave={clearAnnHover}
          >
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
            onClose={close}
            initialGloss={pick.initialGloss}
            initialDict={pick.initialDict}
            feedbackEnabled={feedbackEnabled}
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
            onCancel={() => void cancelRecord(pick)}
          />
        ) : (
          <p className="reader-hint">点击文中单词，或拖住一句话 —— 释义会显示在这里</p>
        )}

        {/* 右栏只放当前这一次的一句话释义；历史回看走正文的绿色标记 */}
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
  onClose,
  onCancel,
  initialGloss,
  initialDict,
  onAIGloss,
  aiContext,
  feedbackEnabled,
}: {
  pick: Pick;
  onClose: () => void;
  /** 取消记录：删掉这个词在本文的记录（右栏、划线、行内中文一起消失） */
  onCancel: () => void;
  /** 回看已存批注时，直接展示当时保存的 AI 释义 */
  initialGloss?: string;
  /** 回看时直接展示当时保存的词典结果快照（不再查词典） */
  initialDict?: DictResult | null;
  /** AI 释义生成完成后回调，用于把结果写回该批注 */
  onAIGloss?: (text: string) => void;
  /** AI 用的上下文（句子边界 + 按需带上一句；锚点的 40 字符窗口只够定位，会切碎句子） */
  aiContext: { prefix: string; suffix: string; withPrevSentence?: boolean };
  feedbackEnabled: boolean;
}) {
  const { anchor, paragraphIdx } = pick;
  // 标题字号随内容长度收缩：单词大字，短语中字，整句小字并限行
  const quote = anchor.quote.trim();
  const titleSize = quote.length > 60 ? 15 : quote.length > 28 ? 16 : quote.length > 14 ? 18 : 20;

  // 词典查询
  const [dict, setDict] = useState<DictResult | null>(null);
  const [dictLoading, setDictLoading] = useState(true);

  // AI 回答对话串（P26）：每次提问追加一段，词典内容和之前的回答都不覆盖
  const [turns, setTurns] = useState<Turn[]>(() => turnsFrom(initialGloss));
  const turnsRef = useRef(turns);
  const updateTurns = (fn: (prev: Turn[]) => Turn[]) => {
    turnsRef.current = fn(turnsRef.current);
    setTurns(turnsRef.current);
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [askPrompt, setAskPrompt] = useState("");
  const busy = turns.some((t) => t.status === "loading" || t.status === "streaming");
  const hasDefault = turns.some((t) => !t.ask);

  // 进行中的 AI 流：切到别的词（弹层按锚点 key 卸载）或重新提问时中止，
  // 服务端随之关掉上游模型流，不再为没人看的答案付费。
  const aiAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => aiAbortRef.current?.abort(), []);


  // 是短语（含空格）还是单词
  const isPhrase = /\s/.test(anchor.quote.trim());

  /** 这个弹层会不会在词典查不到时自动问老师（用于文案，也用于避免误导） */
  const autoExplain = shouldAutoExplain({
    dictHit: Boolean(dict?.entry),
    hasInitialGloss: Boolean(initialGloss),
    fromAnnotation: Boolean(pick.fromAnnotation),
    repeatCount: pick.signals?.repeatCount,
  });

  /** 回看（P25）：点的是「以前查过的那一条」，不是新选区 —— 词典和 AI 都不再请求，
      直接摊开当时存下的词典快照和 AI 释义。没存过 AI 释义的，留一个手动入口。 */
  const recall = Boolean(pick.fromAnnotation);

  // 弹层打开时自动查词典；查不到就顺着第 2 层直接开始 AI 释义。
  // 自动触发挂在 fetch 回调里而不是一个「看 dict state」的 effect：
  // 组件复用时 state 会短暂残留上一次的结果，只有请求自己确认「这次没命中」才可靠。
  useEffect(() => {
    setDict(recall ? (initialDict ?? null) : null);
    setDictLoading(!recall);
    turnsRef.current = turnsFrom(initialGloss);
    setTurns(turnsRef.current);
    setMenuOpen(false);
    setAskPrompt("");

    // 回看：一次请求都不发（词典 / AI 都不查），直接展示存下来的结果。
    if (recall) return;

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
            repeatCount: pick.signals?.repeatCount,
          })
        ) {
          // 词典给不出答案：用户已经停下来请教了，别再让他多点一次按钮。
          // 此时 dict state 还是 null，triggerAI() 里算出的 dictHit=false 正是实情。
          void triggerAI({ askKind: "auto" as const });
        }
      })
      .catch(() => {
        if (!cancelled) setDictLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [anchor.quote, initialGloss, recall]);

  /** 选区所在的整句（「整句没看懂」用）：采集信号时已经算好；回看时由 AI 上下文拼回 */
  const sentence = (
    pick.signals?.sentence || `${aiContext.prefix}${anchor.quote}${aiContext.suffix}`
  ).trim();
  const isWholeSentence = sentence.length > 0 && quote.length >= sentence.length - 2;

  /** 「问 AI」里的选项：只列这一刻有意义的 */
  const askOptions: { label: string; req: AskReq }[] = [
    ...(!hasDefault
      ? [{ label: isPhrase ? "这个短语在这句里什么意思" : "这个词在这句里什么意思", req: { askKind: "default" as const } }]
      : (pick.signals?.repeatCount ?? 1) >= 2
        ? [{ label: "只讲这个词，不讲整句", req: { ask: "只讲这个词", forceWord: true, askKind: "word_only" as const } }]
        : []),
    ...(!isWholeSentence
      ? [
          {
            label: "整句没看懂",
            req: {
              ask: "整句没看懂",
              askKind: "whole_sentence" as const,
              word: sentence,
              wholeSentence: true,
              prompt:
                "这句话里的词我基本都认识，但整句没看懂。第一行按「释义：」格式给出整句的中文翻译；" +
                "然后用一两行点明这句难在哪里（结构、指代、搭配或背景知识），帮我下次自己能拆开；必要时再给句子地图。",
            },
          },
        ]
      : []),
    {
      label: "讲讲句子结构",
      req: {
        ask: "讲讲句子结构",
        askKind: "structure" as const,
        prompt: `讲讲这句话的结构：主干（主语、谓语、宾语或表语）是什么，「${quote}」在其中充当什么、修饰谁。`,
      },
    },
    {
      label: "再给个例句",
      req: {
        ask: "再给个例句",
        askKind: "example" as const,
        prompt: `用「${quote}」在这句里的这个意思，再给一个简单的英文例句，并附中文翻译。`,
      },
    },
  ];

  /**
   * 向 AI 提一个问题（流式），回答追加在对话串末尾。
   * req 为空 = 默认讲解（点词自动触发的那次）；forceWord = 把同句加深清零，只讲这个词。
   */
  async function triggerAI(req: AskReq = {}) {
    const controller = new AbortController();
    aiAbortRef.current = controller;
    const index = turnsRef.current.length;
    updateTurns((prev) => [...prev, { ask: req.ask, text: "", status: "loading", req }]);
    const patch = (p: Partial<Turn>) =>
      updateTurns((prev) => prev.map((t, i) => (i === index ? { ...t, ...p } : t)));

    // 客观信号：前端只采集证据，不下结论。整句提问不带选区信号（选区就是整句）。
    const signals =
      pick.signals && !req.wholeSentence
        ? {
            ...pick.signals,
            dictHit: Boolean(dict?.entry),
            ...(req.forceWord ? { repeatCount: 0, priorAsks: undefined } : {}),
          }
        : undefined;

    const body = req.wholeSentence
      ? { word: req.word ?? sentence, prefix: "", suffix: "", language: "en", monolingual: false, prompt: req.prompt, askKind: req.askKind ?? "default" }
      : {
          word: anchor.quote,
          prefix: aiContext.prefix,
          suffix: aiContext.suffix,
          ...(aiContext.withPrevSentence ? { withPrevSentence: true } : {}),
          language: "en",
          monolingual: false,
          ...(req.prompt ? { prompt: req.prompt } : {}),
          ...(signals ? { signals } : {}),
          askKind: req.askKind ?? "default",
          ...(pick.contextId ? { contextId: pick.contextId } : {}),
        };

    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // 429 = 今天的免费 AI 次数用完（P28）：把服务端的原话显示出来，告诉用户怎么办
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "请求失败");
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("无法读取流");

      // P32：这段回答的 id 用于「太浅 / 刚好 / 太深」反馈
      patch({ answerId: res.headers.get("X-RF-Answer-Id") ?? undefined, status: "streaming" });
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        // 服务端遇到限流/繁忙会自动重试，重开前吐一个重置标记：丢掉上一次的半成品
        if (text.includes(STREAM_RESET)) text = text.split(STREAM_RESET).pop() ?? "";
        patch({ text });
      }
      patch({ text, status: "done" });
      // 整串写回这条记录：回看时原样还原。「没配模型」的引导 / 报错不是答案，不入串
      const keep = turnsRef.current.filter((t) => t.status === "done" && !isNotAGloss(t.text));
      if (!isNotAGloss(text)) onAIGloss?.(serializeThread(keep));
    } catch (err) {
      // 被主动中止（切词 / 卸载）不是错误：半截答案不写回
      if (controller.signal.aborted) return;
      patch({ text: `[Error: ${err instanceof Error ? err.message : "AI 释义失败"}]`, status: "error" });
    }
  }

  /** P32 F5：乐观更新，失败恢复原状并把原因放进 title */
  async function rate(index: number, rating: Feedback) {
    const prev = turnsRef.current[index]?.feedback;
    const answerId = turnsRef.current[index]?.answerId;
    if (!answerId) return;
    const patchTurn = (p: Partial<Turn>) =>
      updateTurns((list) => list.map((t, i) => (i === index ? { ...t, ...p } : t)));
    patchTurn({ feedback: rating, feedbackError: undefined });
    try {
      const res = await fetch("/api/explain/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answerId, rating }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? "反馈没保存上");
      }
    } catch (err) {
      patchTurn({ feedback: prev, feedbackError: err instanceof Error ? err.message : "反馈没保存上" });
    }
  }

  /** 失败或「没配模型」的那一段：去掉它，用同一个问题再问一次 */
  function retry(index: number) {
    const req = turnsRef.current[index]?.req ?? {};
    updateTurns((prev) => prev.filter((_, i) => i !== index));
    void triggerAI(req);
  }

  function askCustom() {
    const q = askPrompt.trim();
    if (!q || busy) return;
    setAskPrompt("");
    setMenuOpen(false);
    void triggerAI({ ask: q, prompt: q, askKind: "custom" as const });
  }

  return (
    <div
      className="reader-note duo-anim-pop"
      onClick={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {/* 标题行：词 + 音标 + 发音，右侧收词/关闭 */}
      <div className="flex items-start justify-between gap-3">
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
                className="rf-ipa hover:text-ink cursor-pointer"
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
          {/* 唯一的操作（P25）：取消这条记录。关闭右栏用点空白处 / Esc，再点一次这个词也会收起 */}
          <button
            className="rf-cancel-record"
            onClick={onCancel}
            disabled={!pick.contextId}
            title={pick.contextId ? "删除这条记录：右栏释义、正文划线和上方的中文一起消失" : "正在保存…"}
            aria-label="取消记录"
          >
            取消记录
          </button>
        </div>
      </div>

      {/* 词典释义：无框平铺。回看时用存下的快照，不查词典，也不引导再问一次 */}
      {dictLoading ? (
        <p className="text-sm font-bold text-ink-faint mt-4">查词典中…</p>
      ) : dict?.entry ? (
        <DictView entry={dict.entry} lemmaForm={dict.lemmaForm} originalForm={dict.originalForm} />
      ) : recall ? null : (
        <p className="text-sm font-bold text-ink-faint mt-4">
          {isPhrase ? "短语不在词典中" : "词典未收录"} ·{" "}
          {autoExplain ? "交给 AI 老师解释" : "可用 AI 解释"}
        </p>
      )}

      {/* AI 对话串：每段一个问题，新回答追加在下面，不覆盖词典和之前的回答 */}
      {turns.map((t, i) => {
        const failed = t.status === "error" || (t.status === "done" && isNotAGloss(t.text));
        return (
          <div className="mt-4" key={i}>
            <div className="flex items-center gap-2 mb-2">
              {t.ask ? (
                <span className="rf-turn-ask">你问：{t.ask}</span>
              ) : (
                <span className="duo-badge duo-badge-green">AI 释义</span>
              )}
              {t.status === "loading" && (
                <span className="text-xs font-bold text-ink-faint">正在思考…</span>
              )}
              {t.status === "streaming" && (
                <span className="text-xs font-bold" style={{ color: "var(--duo-green-dark)" }}>
                  生成中…
                </span>
              )}
              {failed && (
                <button className="rf-ask-mini" onClick={() => retry(i)}>
                  {t.status === "error" ? "重试" : "配置好模型后重试"}
                </button>
              )}
            </div>
            <div className="rf-md text-sm leading-relaxed text-ink">
              <MarkdownText text={t.text} />
              {t.status === "streaming" && (
                <span
                  className="inline-block w-1.5 h-4 ml-1 align-middle animate-pulse"
                  style={{ background: "var(--duo-green)" }}
                />
              )}
            </div>
            {feedbackEnabled && t.status === "done" && !isNotAGloss(t.text) && t.answerId && (
              <div className="rf-feedback-row" title={t.feedbackError}>
                <span>这次讲得：</span>
                {(["shallow", "right", "deep"] as const).map((r, j) => (
                  <span key={r}>
                    {j > 0 && <span aria-hidden> · </span>}
                    <button
                      type="button"
                      className={`rf-feedback-btn ${t.feedback === r ? "rf-feedback-on" : ""}`}
                      aria-pressed={t.feedback === r}
                      title={t.feedbackError || undefined}
                      onClick={() => void rate(i, r)}
                    >
                      {["太浅", "刚好", "太深"][j]}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* 唯一的 AI 入口（P26）：合并原来的「AI 释义」和「追问」。展开后选一个常见问题，或自己输入 */}
      <div className="rf-ai-section">
        <button
          className="rf-ai-primary"
          disabled={busy}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ✨ 问 AI {menuOpen ? "▴" : "▾"}
        </button>
        {menuOpen && !busy && (
          <div className="rf-ask-menu">
            {askOptions.map((o) => (
              <button
                key={o.label}
                className="rf-ask-chip"
                onClick={() => {
                  setMenuOpen(false);
                  void triggerAI(o.req);
                }}
              >
                {o.label}
              </button>
            ))}
            <div className="rf-ask-custom">
              <input
                className="duo-input"
                placeholder="自己写个问题…"
                value={askPrompt}
                onChange={(e) => setAskPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") askCustom();
                }}
              />
              <button
                className="rf-ask-send"
                disabled={!askPrompt.trim()}
                onClick={askCustom}
                aria-label="发送问题"
                title="发送"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 3 10.5 13.5" />
                  <path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 锚点信息 */}
      <details className="mt-4">
        <summary className="text-xs font-bold uppercase tracking-wide text-ink-faint cursor-pointer">
          上下文锚点
        </summary>
        <div className="space-y-2 mt-2">
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
        <div className="flex items-center gap-2 mb-2">
          <span className="duo-badge duo-badge-green">{lemmaForm}</span>
          <span className="text-xs font-bold text-ink-faint">← 原形</span>
        </div>
      )}

      {entry.translation && (
        <p className="text-base font-semibold leading-relaxed text-ink whitespace-pre-line">
          {normalizeTranslation(entry.translation)}
        </p>
      )}

      {entry.definition && entry.definition.length > 0 && (
        <details className="mt-2">
          <summary className="text-xs font-bold text-ink-faint cursor-pointer">
            英文释义
          </summary>
          <p className="text-sm leading-relaxed text-ink-soft mt-2 whitespace-pre-line">
            {normalizeTranslation(entry.definition)}
          </p>
        </details>
      )}

      {entry.collins && entry.collins > 0 && (
        <div className="flex items-center gap-1 mt-2">
          <span className="text-xs font-bold text-ink-faint">柯林斯</span>
          {"★".repeat(Math.min(entry.collins, 5)).split("").map((s, i) => (
            <span key={i} className="text-xs" style={{ color: "var(--duo-orange)" }}>{s}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed">
      <span className="text-ink-faint shrink-0 w-9 font-bold">{label}</span>
      <span className="text-ink-soft font-mono break-all">{value}</span>
    </div>
  );
}


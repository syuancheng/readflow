import { JSDOM } from "jsdom";
import { makeBuilder, type TextBuilder } from "./builder";
import { cleanInfoString, type Block, type CalloutKind } from "./types";

/**
 * Readability 提取出的 HTML → IR（URL 导入的 fallback 路径）。
 *
 * 没有走「HTML→Markdown→IR」是因为 turndown 这类转换器对
 * colspan / 嵌套列表 / 语法高亮的 <pre><span> 是有损的；
 * 直接用 jsdom 遍历 DOM 能保住表格行列和代码缩进，也少一个依赖。
 * 两条路径最终都产出同一个 Block[]，下游完全不区分来源。
 */

type Ctx = { listCounter: number; tableCounter: number };

const LIST_TAGS = new Set(["ul", "ol"]);
const BLOCK_LIKE = new Set([
  "div",
  "section",
  "article",
  "main",
  "figure",
  "aside",
  "details",
  "summary",
  "header",
  "footer",
]);
const IGNORE_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "form",
  "button",
  "nav",
  "template",
]);
/** 由外层单独成块，inline 遍历时跳过，避免文字被重复收进父段落 */
const STRUCTURAL_TAGS = new Set(["ul", "ol", "table", "pre", "blockquote"]);

function soft(value: string): string {
  return value.replace(/\s*\n\s*/g, " ");
}

function absoluteUrl(el: Element, attr: "href" | "src"): string | undefined {
  const raw = el.getAttribute(attr);
  if (!raw) return undefined;
  const anyEl = el as unknown as Record<string, string>;
  const resolved = anyEl[attr]; // JSDOM 会把 href / src 解析成绝对地址
  return resolved || raw;
}

function inlineDom(node: Node, b: TextBuilder): void {
  if (node.nodeType === 3) {
    b.add(soft(node.textContent ?? ""));
    return;
  }
  if (node.nodeType !== 1) return;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (IGNORE_TAGS.has(tag) || STRUCTURAL_TAGS.has(tag)) return;

  const children = () => {
    for (const c of Array.from(el.childNodes)) inlineDom(c, b);
  };

  switch (tag) {
    case "strong":
    case "b":
      b.range("strong", children);
      break;
    case "em":
    case "i":
      b.range("em", children);
      break;
    case "del":
    case "s":
    case "strike":
      b.range("delete", children);
      break;
    case "code":
    case "kbd":
    case "samp":
      // 语法高亮会在 <code> 里塞一堆 <span>，整体取 textContent 才不丢字符
      b.range("code", () => b.add(soft(el.textContent ?? "")));
      break;
    case "a":
      b.range("link", children, absoluteUrl(el, "href"));
      break;
    case "img":
      b.range("image", () => b.add(el.getAttribute("alt") || "image"), absoluteUrl(el, "src"));
      break;
    case "br":
      b.add(" ");
      break;
    case "p":
    case "li":
      // 出现在 inline 上下文里时（例如 li 套 p）当作普通容器，
      // 段间空格由调用方的 emit 负责
      children();
      break;
    default:
      children();
      break;
  }
}

function makeInline(el: Element): Block {
  const b = makeBuilder();
  for (const c of Array.from(el.childNodes)) inlineDom(c, b);
  return b.build("paragraph");
}

function headingOf(el: Element): Block {
  const b = makeBuilder();
  for (const c of Array.from(el.childNodes)) inlineDom(c, b);
  const depth = Number(el.tagName.slice(1)) || 2;
  return b.build("heading", { depth: Math.min(6, Math.max(1, depth)) });
}

function listBlocks(el: Element, ctx: Ctx, depth: number): Block[] {
  const listId = `l${ctx.listCounter++}`;
  const ordered = el.tagName.toLowerCase() === "ol";
  const out: Block[] = [];

  const lis = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === "li");
  lis.forEach((li, i) => {
    const b = makeBuilder();
    for (const c of Array.from(li.childNodes)) {
      if (c.nodeType === 1 && LIST_TAGS.has((c as Element).tagName.toLowerCase())) continue;
      inlineDom(c, b);
    }
    out.push(
      b.build("list_item", {
        listId,
        ordered,
        listDepth: depth,
        marker: ordered ? `${i + 1}.` : "•",
      }),
    );

    for (const nested of Array.from(li.children)) {
      if (LIST_TAGS.has(nested.tagName.toLowerCase())) {
        out.push(...listBlocks(nested, ctx, depth + 1));
      }
    }
  });

  return out;
}

function alignOf(cell: Element): "left" | "center" | "right" | null {
  const a = (cell.getAttribute("align") || "").toLowerCase();
  if (a === "left" || a === "center" || a === "right") return a;
  const style = (cell.getAttribute("style") || "").toLowerCase();
  if (style.includes("text-align: center")) return "center";
  if (style.includes("text-align: right")) return "right";
  return null;
}

function tableBlocks(el: Element, ctx: Ctx): Block[] {
  const tableId = `t${ctx.tableCounter++}`;
  const trs = Array.from(el.querySelectorAll("tr")).filter(
    (tr) => tr.closest("table") === el,
  );
  const cellsOf = (tr: Element) =>
    Array.from(tr.children).filter((c) => /^(td|th)$/.test(c.tagName.toLowerCase()));
  const colCount = trs.reduce((m, tr) => Math.max(m, cellsOf(tr).length), 0);
  const out: Block[] = [];

  trs.forEach((tr, r) => {
    const cells = cellsOf(tr);
    cells.forEach((cell, c) => {
      const b = makeBuilder();
      for (const child of Array.from(cell.childNodes)) inlineDom(child, b);
      out.push(
        b.build("table_cell", {
          tableId,
          row: r,
          col: c,
          header: r === 0 || cell.tagName.toLowerCase() === "th",
          align: alignOf(cell),
          rowCount: trs.length,
          colCount,
        }),
      );
    });
  });

  return out;
}

const CALLOUT_TEXT = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/i;
const CALLOUT_CLASS = /\b(note|tip|warning|important|caution|callout)\b/i;

function quoteBlock(el: Element): Block {
  const b = makeBuilder();
  let callout: CalloutKind | null = null;

  const emit = (nodes: Node[]): void => {
    const probe = makeBuilder();
    for (const n of nodes) inlineDom(n, probe);
    if (!probe.value.trim()) return;
    if (b.length > 0) b.add(" ");
    for (const n of nodes) inlineDom(n, b);
  };

  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (/^(p|h[1-6]|div|section)$/.test(tag)) emit(Array.from(child.childNodes));
    else emit([child]);
  }
  if (!b.length) emit(Array.from(el.childNodes));

  const m = b.value.match(CALLOUT_TEXT);
  if (m) callout = m[1].toUpperCase() as CalloutKind;
  const cls = `${el.className || ""} ${el.getAttribute("data-callout") || ""}`;
  if (!callout && CALLOUT_CLASS.test(cls)) {
    const hit = cls.match(/\b(note|tip|warning|important|caution)\b/i)?.[1];
    if (hit) callout = hit.toUpperCase() as CalloutKind;
  }

  return b.build("quote", { callout });
}

function codeBlock(el: Element): Block {
  const b = makeBuilder();
  // <pre> 里的换行是内容，绝不能 soft() 压成空格
  b.add(el.textContent ?? "");
  const code = el.querySelector("code");
  const cls = code?.className || "";
  const lang =
    cleanInfoString(code?.getAttribute("data-language")) ??
    cleanInfoString(cls.match(/language-([^\s]+)/)?.[1]) ??
    cleanInfoString(el.getAttribute("data-language"));
  return b.build("code", { lang: lang ?? undefined });
}

function walk(parent: Element, out: Block[], ctx: Ctx): void {
  let loose = "";

  const flushLoose = () => {
    const t = loose.trim();
    loose = "";
    if (!t) return;
    const b = makeBuilder();
    b.add(t);
    out.push(b.build("paragraph"));
  };

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3) {
      loose += soft(child.textContent ?? "");
      continue;
    }
    if (child.nodeType !== 1) continue;

    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (IGNORE_TAGS.has(tag)) continue;
    // 站点给 agent 看的隐藏索引，原网页上看不见
    if (el.hasAttribute("data-agent-docs-index") || el.classList.contains("sr-only")) continue;

    flushLoose();

    if (/^h[1-6]$/.test(tag)) {
      out.push(headingOf(el));
    } else if (tag === "p") {
      out.push(makeInline(el));
    } else if (LIST_TAGS.has(tag)) {
      out.push(...listBlocks(el, ctx, 0));
    } else if (tag === "table") {
      out.push(...tableBlocks(el, ctx));
    } else if (tag === "pre") {
      out.push(codeBlock(el));
    } else if (tag === "blockquote") {
      out.push(quoteBlock(el));
    } else if (tag === "hr") {
      out.push(makeBuilder().build("hr"));
    } else if (tag === "li") {
      out.push(makeInline(el));
    } else if (BLOCK_LIKE.has(tag)) {
      walk(el, out, ctx);
    } else {
      const b = makeBuilder();
      inlineDom(el, b);
      if (b.value.trim()) out.push(b.build("paragraph"));
    }
  }

  flushLoose();
}

export function parseHtmlBlocks(html: string, baseUrl?: string): Block[] {
  const dom = new JSDOM(html, { url: baseUrl || "https://localhost/" });
  const out: Block[] = [];
  walk(dom.window.document.body, out, { listCounter: 0, tableCounter: 0 });

  return out.filter((b) => {
    if (b.kind === "hr" || b.kind === "code" || b.kind === "table_cell") return true;
    return b.text.trim().length > 0;
  });
}

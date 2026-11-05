import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type {
  Blockquote,
  Code,
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
  Text,
} from "mdast";
import { makeBuilder, type TextBuilder } from "./builder";
import { cleanInfoString, type Block, type CalloutKind } from "./types";

/**
 * Markdown → IR。用 mdast 而不是自己写正则：GFM 表格、嵌套列表、
 * 代码块、链接里的括号、转义、callout 这些边界情况手写正则必然踩坑。
 *
 * remark-gfm 通过 processor.data() 注入 micromark 扩展，
 * 所以 .parse() 时表格就会被解析成 table 节点（不是 paragraph）。
 */
const processor = unified().use(remarkParse).use(remarkGfm);

type Ctx = { listCounter: number; tableCounter: number };

/** 可见纯文本里的换行统一成空格；Markdown 软换行渲染后本来就是空格。 */
function soft(value: string): string {
  return value.replace(/\s*\n\s*/g, " ");
}

/** 剥掉 HTML 标签只留文字：绝不把用户提供的 HTML 交给浏览器渲染。 */
function plainHtml(value: string): string {
  return soft(value.replace(/<[^>]*>/g, ""));
}

/**
 * Mintlify / GitHub 文档站会在标题里塞一个空的锚点链接：`## [ ](#id) Title`。
 * 原网页上看不见，但如果照抄成可见的 `<a> </a>`，标题前就会多一个空格链接。
 */
function isBlankLink(node: PhrasingContent): boolean {
  if (node.type !== "link") return false;
  const text = (node.children as PhrasingContent[])
    .map((c) => (c.type === "text" ? c.value : ""))
    .join("");
  return text.trim() === "";
}

/**
 * 去掉文档站标题里的空锚点链接，并吃掉它留在后面的那个空格。
 * `## [ ](#id) Title` 若只删链接不删空格，可见文本会变成 " Title"，
 * 前端就会渲染出一个多出来的前导空格。
 */
function cleanBlankLinks(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let dropSpace = false;
  for (const node of nodes) {
    if (isBlankLink(node)) {
      dropSpace = true;
      continue;
    }
    if (dropSpace && node.type === "text") {
      out.push({ ...node, value: node.value.replace(/^\s+/, "") });
      dropSpace = false;
      continue;
    }
    dropSpace = false;
    out.push(node);
  }
  return out;
}

function inline(srcNodes: PhrasingContent[], b: TextBuilder): void {
  const nodes = cleanBlankLinks(srcNodes);
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "html":
        b.add(node.type === "text" ? soft(node.value) : plainHtml(node.value));
        break;
      case "strong":
        b.range("strong", () => inline(node.children as PhrasingContent[], b));
        break;
      case "emphasis":
        b.range("em", () => inline(node.children as PhrasingContent[], b));
        break;
      case "delete":
        b.range("delete", () => inline(node.children as PhrasingContent[], b));
        break;
      case "inlineCode":
        b.range("code", () => b.add(soft(node.value)));
        break;
      case "link":
        if (isBlankLink(node)) break;
        b.range("link", () => inline(node.children as PhrasingContent[], b), node.url);
        break;
      case "linkReference":
        inline(node.children as PhrasingContent[], b);
        break;
      case "image":
        b.range("image", () => b.add(node.alt || "image"), node.url);
        break;
      case "imageReference":
        b.add(node.alt || "image");
        break;
      case "break":
        b.add(" ");
        break;
      case "footnoteReference":
        break;
      default: {
        // switch 已穷举 PhrasingContent，TS 把 default 收窄成 never；
        // 这里显式放宽，给未来的 mdast 扩展留一个「别静默丢正文」的兜底
        const rest = node as unknown as { children?: unknown; value?: unknown };
        if (Array.isArray(rest.children)) inline(rest.children as PhrasingContent[], b);
        else if (typeof rest.value === "string") b.add(soft(rest.value));
        break;
      }
    }
  }
}

function paragraphBlock(node: Paragraph, kind: Block["kind"], meta: Block["meta"] = {}): Block {
  const b = makeBuilder();
  inline(node.children as PhrasingContent[], b);
  return b.build(kind, meta);
}

function headingBlock(node: Heading): Block {
  const b = makeBuilder();
  inline(node.children as PhrasingContent[], b);
  return b.build("heading", { depth: Math.min(6, Math.max(1, node.depth)) });
}

function tableBlocks(node: Table, ctx: Ctx): Block[] {
  const tableId = `t${ctx.tableCounter++}`;
  const rows = node.children as TableRow[];
  const rowCount = rows.length;
  const colCount = rows.reduce((m, r) => Math.max(m, (r.children as TableCell[]).length), 0);

  const out: Block[] = [];
  rows.forEach((row, r) => {
    (row.children as TableCell[]).forEach((cell, c) => {
      const b = makeBuilder();
      inline(cell.children as PhrasingContent[], b);
      out.push(
        b.build("table_cell", {
          tableId,
          row: r,
          col: c,
          header: r === 0,
          align: node.align?.[c] ?? null,
          rowCount,
          colCount,
        }),
      );
    });
  });
  return out;
}

function codeBlock(node: Code): Block {
  // value 是唯一保留原始换行的块：代码缩进 / 逐行结构本身就是内容。
  const b = makeBuilder();
  b.add(node.value);
  return b.build("code", { lang: cleanInfoString(node.lang) ?? undefined });
}

function listBlocks(node: List, ctx: Ctx, depth: number): Block[] {
  const listId = `l${ctx.listCounter++}`;
  const items = node.children as ListItem[];
  const out: Block[] = [];

  items.forEach((item, i) => {
    let first = true;
    for (const child of item.children as RootContent[]) {
      if (child.type === "paragraph") {
        const meta: Block["meta"] = {
          listId,
          ordered: node.ordered === true,
          listDepth: depth,
          marker: node.ordered === true ? `${(node.start ?? 1) + i}.` : "•",
          checked: item.checked ?? null,
        };
        // 同一个 listItem 里的续段也算列表项，避免视觉上跑出列表外面
        out.push(paragraphBlock(child as Paragraph, "list_item", meta));
        first = false;
      } else if (child.type === "list") {
        out.push(...listBlocks(child as List, ctx, depth + 1));
      } else {
        out.push(...walk([child], ctx));
        first = false;
      }
    }
    if (first) {
      // 空的 listItem（只有一个换行）也留一条，避免列表项数对不上
      const b = makeBuilder();
      out.push(
        b.build("list_item", {
          listId,
          ordered: node.ordered === true,
          listDepth: depth,
          checked: item.checked ?? null,
        }),
      );
    }
  });

  return out;
}

const CALLOUT_RE = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/i;

/**
 * 把整个 blockquote 摊成一个 quote Block（提示框通常只有 1~3 句，
 * 合成一个块比在前端重组嵌套引用可靠得多）。
 * `[!NOTE]` 只作为 meta，不进入可见文本。
 *
 * 段间补空格必须在追加**之前**做：ranges 的 start/end 是追加那一刻的
 * 文本长度，事后插入分隔符会让所有区间整体错位。
 */
function quoteBlock(node: Blockquote, ctx: Ctx): Block {
  const b = makeBuilder();
  let callout: CalloutKind | null = null;

  const emit = (children: PhrasingContent[]): void => {
    const probe = makeBuilder();
    inline(children, probe);
    if (!probe.value.trim()) return;
    if (b.length > 0) b.add(" ");
    inline(children, b);
  };

  const visit = (n: Blockquote, isRoot: boolean): void => {
    n.children.forEach((child, idx) => {
      if (child.type === "blockquote") {
        visit(child as Blockquote, false);
        return;
      }
      if (child.type === "paragraph") {
        let children = (child as Paragraph).children as PhrasingContent[];
        if (isRoot && idx === 0 && children[0]?.type === "text") {
          const m = (children[0] as Text).value.match(CALLOUT_RE);
          if (m) {
            callout = m[1].toUpperCase() as CalloutKind;
            const rest = (children[0] as Text).value.slice(m[0].length);
            children = rest
              ? [{ ...(children[0] as Text), value: rest }, ...children.slice(1)]
              : children.slice(1);
          }
        }
        emit(children);
        return;
      }
      // 引用里的列表 / 表格 / 代码块：文字合进来，块结构不再单独保留
      const parts = walk([child], ctx)
        .map((nb) => nb.text.trim())
        .filter(Boolean);
      if (!parts.length) return;
      if (b.length > 0) b.add(" ");
      b.add(parts.join(" "));
    });
  };

  visit(node, true);
  return b.build("quote", {
    callout,
    skip: isAgentOnlyIndex(b.value),
  });
}

/** Mintlify 会往 Copy page 的 Markdown 里塞一段给 agent 看的隐藏索引。 */
function isAgentOnlyIndex(text: string): boolean {
  return /Documentation Index/i.test(text) && /llms\.txt/i.test(text);
}

function walk(nodes: RootContent[], ctx: Ctx): Block[] {
  const out: Block[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        out.push(paragraphBlock(node as Paragraph, "paragraph"));
        break;
      case "heading":
        out.push(headingBlock(node as Heading));
        break;
      case "blockquote":
        out.push(quoteBlock(node as Blockquote, ctx));
        break;
      case "list":
        out.push(...listBlocks(node as List, ctx, 0));
        break;
      case "table":
        out.push(...tableBlocks(node as Table, ctx));
        break;
      case "code":
        out.push(codeBlock(node as Code));
        break;
      case "thematicBreak": {
        const b = makeBuilder();
        out.push(b.build("hr"));
        break;
      }
      case "html":
        // 块级 HTML 不渲染，只保留纯文字（例如 <details> 里的说明）
        if (plainHtml(node.value).trim()) {
          const b = makeBuilder();
          b.add(plainHtml(node.value).trim());
          out.push(b.build("paragraph"));
        }
        break;
      case "definition":
      case "footnoteDefinition":
        break;
      default:
        break;
    }
  }
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const tree = processor.parse(src) as Root;
  const blocks = walk(tree.children, { listCounter: 0, tableCounter: 0 });

  return blocks.filter((b) => {
    if (b.meta.skip) return false; // 隐藏的 agent-only 索引，原网页上也看不见
    if (b.kind === "hr" || b.kind === "code" || b.kind === "table_cell") return true;
    return b.text.trim().length > 0;
  });
}

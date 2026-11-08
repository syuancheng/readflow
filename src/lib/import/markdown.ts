import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
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
 * remark-math 同理：$$…$$ → math（块级），$…$ → inlineMath。
 */
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

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

/**
 * 图片 / 链接地址解析：URL 导入的官方 Markdown 里图片常是相对路径（/img/a.png），
 * 站点上下文丢了就 404。有 baseUrl 时统一解析成绝对地址，失败原样返回。
 */
function resolveUrl(url: string, base?: string): string {
  if (!base) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function inline(srcNodes: PhrasingContent[], b: TextBuilder, base?: string): void {
  const nodes = cleanBlankLinks(srcNodes);
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "html":
        b.add(node.type === "text" ? soft(node.value) : plainHtml(node.value));
        break;
      case "strong":
        b.range("strong", () => inline(node.children as PhrasingContent[], b, base));
        break;
      case "emphasis":
        b.range("em", () => inline(node.children as PhrasingContent[], b, base));
        break;
      case "delete":
        b.range("delete", () => inline(node.children as PhrasingContent[], b, base));
        break;
      case "inlineCode":
        b.range("code", () => b.add(soft(node.value)));
        break;
      case "link":
        if (isBlankLink(node)) break;
        b.range("link", () => inline(node.children as PhrasingContent[], b, base), resolveUrl(node.url, base));
        break;
      case "linkReference":
        inline(node.children as PhrasingContent[], b, base);
        break;
      case "image":
        b.range("image", () => b.add(node.alt || "image"), resolveUrl(node.url, base));
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
        // 这里显式放宽，给 mdast 扩展（remark-math 的 inlineMath 等）留
        // 「别静默丢正文」的兜底
        const rest = node as unknown as { type?: string; children?: unknown; value?: unknown };
        if (rest.type === "inlineMath" && typeof rest.value === "string") {
          const v = rest.value;
          if (/^\s|\s$/.test(v)) {
            // 货币保护（P17）：remark-math 允许闭 $ 前是空白，"$5 and $10"
            // 会被捕获成公式 —— 首尾带空白的不是公式，按字面文本还原美元符
            b.add(`$${v}$`);
          } else {
            // 行内公式：文本保留 LaTeX 源（坐标基准），标成 math 区间——
            // 前端渲染 KaTeX + 隐藏原文；词数 / CEFR 统计时整段剔除。
            b.range("math", () => b.add(v));
          }
        } else if (Array.isArray(rest.children)) {
          inline(rest.children as PhrasingContent[], b, base);
        } else if (typeof rest.value === "string") {
          b.add(soft(rest.value));
        }
        break;
      }
    }
  }
}

/**
 * 图片专属段落 → figure 块。文章配图几乎都独占一段（`![alt](url)`），
 * 提升成块后前端渲染真图；alt 当 figcaption。
 * 兼容 `[![alt](img)](link)`（图片整体带链接）——取内层图片。
 */
function figureBlocks(node: Paragraph, base?: string): Block[] | null {
  const imgs: { url: string; alt: string }[] = [];
  for (const child of node.children as PhrasingContent[]) {
    if (child.type === "image") {
      imgs.push({ url: child.url, alt: child.alt || "" });
      continue;
    }
    if (child.type === "link") {
      const inner = (child.children as PhrasingContent[]).filter((c) => c.type === "image");
      if (inner.length > 0 && inner.length === (child.children as PhrasingContent[]).length) {
        for (const c of inner) imgs.push({ url: (c as { url: string }).url, alt: (c as { alt: string | null }).alt || "" });
        continue;
      }
    }
    if (child.type === "text" && !child.value.trim()) continue;
    return null; // 混有正文文字：不是配图段落，走普通 paragraph
  }
  if (imgs.length === 0) return null;
  return imgs.map((img) => {
    const b = makeBuilder();
    b.add(img.alt);
    return b.build("figure", { src: resolveUrl(img.url, base), alt: img.alt });
  });
}

/**
 * 单独成段的行内公式 → 块级 math。
 * remark-math 的 flow 语法要求 `$$` 独占一行（栅栏式）；实际文档里大量
 * `$$J=r$$` 单行写法会被解析成「只含一个 inlineMath 的段落」。
 * 这种段落没有别的可见内容，提升成 display 公式块（居中、可滚动、不计词数）。
 */
function displayMathFromParagraph(node: Paragraph): Block | null {
  const kids = (node.children as PhrasingContent[]).filter(
    (c) => !(c.type === "text" && !c.value.trim()),
  );
  if (kids.length !== 1) return null;
  const only = kids[0] as unknown as { type: string; value?: string };
  if (only.type !== "inlineMath" || typeof only.value !== "string") return null;
  const b = makeBuilder();
  b.add(only.value);
  return b.build("math", { display: true });
}

function paragraphBlock(
  node: Paragraph,
  kind: Block["kind"],
  meta: Block["meta"] = {},
  base?: string,
): Block {
  const b = makeBuilder();
  inline(node.children as PhrasingContent[], b, base);
  return b.build(kind, meta);
}

function headingBlock(node: Heading, base?: string): Block {
  const b = makeBuilder();
  inline(node.children as PhrasingContent[], b, base);
  return b.build("heading", { depth: Math.min(6, Math.max(1, node.depth)) });
}

function tableBlocks(node: Table, ctx: Ctx, base?: string): Block[] {
  const tableId = `t${ctx.tableCounter++}`;
  const rows = node.children as TableRow[];
  const rowCount = rows.length;
  const colCount = rows.reduce((m, r) => Math.max(m, (r.children as TableCell[]).length), 0);

  const out: Block[] = [];
  rows.forEach((row, r) => {
    (row.children as TableCell[]).forEach((cell, c) => {
      const b = makeBuilder();
      inline(cell.children as PhrasingContent[], b, base);
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

function listBlocks(node: List, ctx: Ctx, depth: number, base?: string): Block[] {
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
        out.push(paragraphBlock(child as Paragraph, "list_item", meta, base));
        first = false;
      } else if (child.type === "list") {
        out.push(...listBlocks(child as List, ctx, depth + 1, base));
      } else {
        out.push(...walk([child], ctx, base));
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
function quoteBlock(node: Blockquote, ctx: Ctx, base?: string): Block {
  const b = makeBuilder();
  let callout: CalloutKind | null = null;

  const emit = (children: PhrasingContent[]): void => {
    const probe = makeBuilder();
    inline(children, probe, base);
    if (!probe.value.trim()) return;
    if (b.length > 0) b.add(" ");
    inline(children, b, base);
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
      const parts = walk([child], ctx, base)
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

function walk(nodes: RootContent[], ctx: Ctx, base?: string): Block[] {
  const out: Block[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph": {
        const para = node as Paragraph;
        // 配图独占一段 → figure 块（前端渲染真图）；混有正文则走普通段落
        const figures = figureBlocks(para, base);
        if (figures) {
          out.push(...figures);
          break;
        }
        // 单行 $$…$$ 写法的公式也提升成块级
        const promoted = displayMathFromParagraph(para);
        if (promoted) {
          out.push(promoted);
          break;
        }
        out.push(paragraphBlock(para, "paragraph", {}, base));
        break;
      }
      case "heading":
        out.push(headingBlock(node as Heading, base));
        break;
      case "blockquote":
        out.push(quoteBlock(node as Blockquote, ctx, base));
        break;
      case "list":
        out.push(...listBlocks(node as List, ctx, 0, base));
        break;
      case "table":
        out.push(...tableBlocks(node as Table, ctx, base));
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
      default: {
        // switch 已穷举 RootContent；mdast 类型不含 remark-math 的 math 节点，
        // 在这里放宽处理（$$…$$ 块级公式）
        const rest = node as unknown as { type?: string; value?: unknown };
        if (rest.type === "math" && typeof rest.value === "string") {
          // content 存 LaTeX 源（保留换行），前端用 KaTeX 渲染。
          // 和 code 同等待遇：不是 prose，不点词、不计词数、不进 CEFR。
          const b = makeBuilder();
          b.add(rest.value);
          out.push(b.build("math", { display: true }));
        }
        break;
      }
    }
  }
  return out;
}

export function parseMarkdown(src: string, baseUrl?: string): Block[] {
  const tree = processor.parse(src) as Root;
  const blocks = walk(tree.children, { listCounter: 0, tableCounter: 0 }, baseUrl);

  return blocks.filter((b) => {
    if (b.meta.skip) return false; // 隐藏的 agent-only 索引，原网页上也看不见
    if (b.kind === "hr" || b.kind === "code" || b.kind === "table_cell" || b.kind === "figure" || b.kind === "math")
      return true;
    return b.text.trim().length > 0;
  });
}

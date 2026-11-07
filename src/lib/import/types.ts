/**
 * 导入中间表示（IR）。
 *
 * 为什么要有这一层：新闻只有段落、论文有图表、技术博客有代码块，
 * 但阅读器、锚点、CEFR、收词、导出都不该关心「原文是什么格式」。
 * 所有输入（pure text / Markdown / HTML）先被各自的适配器压成同一个 Block[]，
 * 下游只认识 Block —— 这是 Pandoc / 编译器前端的同一个思路。
 *
 * 最重要的不变量：
 *   block.text 是「用户能看见的纯文本」，不含任何 Markdown / HTML 标记；
 *   contexts.start / end 永远是 text 的字符下标；
 *   一个 Block = paragraphs 表的一行 = 一个 data-pid 容器。
 * 只要守住这三条，resolveAnchor / sentenceAround / aiContextOf / cardgen
 * 就都不需要改。
 */

export type BlockKind =
  | "paragraph"
  | "heading"
  | "list_item"
  | "table_cell"
  | "quote"
  | "code"
  | "hr"
  | "figure"
  | "math";

export type InlineKind = "strong" | "em" | "delete" | "code" | "link" | "image" | "math";

/** 相对 block.text 的 [start, end) 区间。样式与文字解耦，不参与坐标计算。 */
export type InlineRange = {
  start: number;
  end: number;
  kind: InlineKind;
  /** link / image 的目标地址 */
  href?: string;
};

export type CalloutKind = "NOTE" | "TIP" | "WARNING" | "IMPORTANT" | "CAUTION";

export type BlockMeta = {
  /** heading 层级 1..6 */
  depth?: number;
  /** 同一列表 / 同一表格的分组 id（确定性生成，方便测试与重跑） */
  listId?: string;
  tableId?: string;
  ordered?: boolean;
  listDepth?: number;
  marker?: string;
  checked?: boolean | null;
  /** 表格坐标 */
  row?: number;
  col?: number;
  header?: boolean;
  align?: "left" | "center" | "right" | null;
  rowCount?: number;
  colCount?: number;
  /** 代码块语言与可选文件名 */
  lang?: string;
  filename?: string;
  /** blockquote：GitHub / Mintlify 的 [!NOTE] 提示框 */
  callout?: CalloutKind | null;
  /** 给 agent 看的隐藏块（如 Mintlify 的 Documentation Index），前端跳过 */
  skip?: boolean;
  /** 图片占位信息 */
  src?: string;
  alt?: string;
  /** math 块：displayMode（$$…$$ 为 true，被提升成块的行内公式为 false） */
  display?: boolean;
};

export type Block = {
  kind: BlockKind;
  text: string;
  ranges: InlineRange[];
  meta: BlockMeta;
};

export type SourceFormat = "plain" | "markdown" | "html";
export type ImportFormatChoice = "auto" | "plain" | "markdown";

/** 这些块不是自然语言正文：不计入词数、CEFR、分段小结，也不生成可点词 span。 */
export const NON_PROSE_KINDS: readonly BlockKind[] = ["code", "hr", "figure", "math"];

export function isProse(b: Pick<Block, "kind">): boolean {
  return !NON_PROSE_KINDS.includes(b.kind);
}

/**
 * 清洗代码围栏的 info string。
 * Mintlify 会写 ```text theme={null}，CommonMark 把首个词当 lang、其余当 meta；
 * 不同解析器给的结果不一致，这里统一只取第一个非空白 token，并挡掉 MDX 属性。
 */
export function cleanInfoString(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0] ?? "";
  if (!first || first.includes("{") || first.includes("}") || first.includes("=")) return null;
  return first.toLowerCase();
}

/** 数据库里存的是 JSON 字符串；解析失败一律降级为空，绝不让阅读页崩。 */
export function parseBlockMeta(raw: string | null | undefined): BlockMeta {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as BlockMeta) : {};
  } catch {
    return {};
  }
}

export function parseInlineRanges(raw: string | null | undefined): InlineRange[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as InlineRange[]) : [];
  } catch {
    return [];
  }
}

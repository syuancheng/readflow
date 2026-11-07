import { detectFormat } from "./detect";
import { parseMarkdown } from "./markdown";
import { parsePlain } from "./plain";
import { isProse, type Block, type ImportFormatChoice, type SourceFormat } from "./types";

export * from "./types";
export { parseMarkdown } from "./markdown";
export { parsePlain } from "./plain";
export { parseHtmlBlocks } from "./html";
export { detectFormat, markdownSignals, describeSignals } from "./detect";
export { groupBlocks, isSkipped, type Group } from "./group";

/** 粘贴 / 上传：自动探测或用户手动指定格式。 */
export function parsePasted(
  raw: string,
  choice: ImportFormatChoice = "auto",
): { blocks: Block[]; format: SourceFormat } {
  const format = choice === "auto" ? detectFormat(raw) : choice;
  const blocks = format === "markdown" ? parseMarkdown(raw) : parsePlain(raw);
  return { blocks, format };
}

/**
 * 空段落过滤。
 * 表格的空单元格、代码块、分隔线必须保留——前者撑住格子对齐，
 * 后两者本来就没有文字但要在页面上出现。figure / math 同理：
 * 图片和公式本身不需要可见文字。
 */
export function pruneBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => {
    if (b.meta.skip) return false;
    if (b.kind === "hr" || b.kind === "code" || b.kind === "table_cell" || b.kind === "figure" || b.kind === "math")
      return true;
    return b.text.trim().length > 0;
  });
}

/**
 * 行内公式区间替换成空格：\rho_s、\arg\max 不是英文单词，
 * 混进词数 / CEFR 会把难度虚高（README 3.2 节记录过同类问题：代码标识符被
 * 当成生僻词）。只影响统计输入，不改块文本本身——锚点坐标纹丝不动。
 */
function stripInlineMath(text: string, ranges: Block["ranges"]): string {
  const math = ranges.filter((r) => r.kind === "math");
  if (math.length === 0) return text;
  let out = text;
  for (const r of [...math].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + " " + out.slice(r.end);
  }
  return out;
}

/**
 * 只把自然语言正文交给词数统计 / CEFR / 分段小结。
 * 代码里的 pnpm、json、__init__ 这类标识符会污染词频，把难度估高；
 * 表格单元格是自然语言，正常计入；行内公式整段剔除（见 stripInlineMath）。
 */
export function proseTexts(blocks: Block[]): string[] {
  return blocks
    .filter(isProse)
    .map((b) => stripInlineMath(b.text, b.ranges))
    .filter((t) => t.trim().length > 0);
}

export function kindCounts(blocks: Block[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of blocks) out[b.kind] = (out[b.kind] ?? 0) + 1;
  return out;
}

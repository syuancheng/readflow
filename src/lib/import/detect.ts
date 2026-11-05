import type { ImportFormatChoice } from "./types";

/**
 * 判断粘贴/上传的内容是不是 Markdown。
 *
 * 为什么不用单一特征：英文小说里偶尔也会出现 `1. ` 编号或一行 `---`，
 * 单行命中就把整篇当 Markdown 会把正常文本里的符号吃掉。
 * 所以要求「至少 1 个强特征 + 总共 ≥2 类特征」，强特征是几乎不会
 * 出现在纯文本里的语法（标题 / 围栏 / 表格 / callout / 链接）。
 *
 * 用户始终可以在导入框里手动覆盖为「纯文本」或「Markdown」。
 */
export type MarkdownSignal =
  | "heading"
  | "fence"
  | "table"
  | "callout"
  | "link"
  | "quote"
  | "list"
  | "inlineCode"
  | "emphasis";

const STRONG: readonly MarkdownSignal[] = ["heading", "fence", "table", "callout", "link"];

const TESTS: readonly (readonly [MarkdownSignal, RegExp])[] = [
  ["heading", /^#{1,6}[ \t]+\S/m],
  ["fence", /^[ \t]*```|^[ \t]*~~~/m],
  // 表格：一行 |...| 且下一行是分隔行。
  // 注意 GFM 允许单横杠（| :- | :- |），不能用 -{2,}，否则官方 .md 会漏判。
  ["table", /^[ \t]*\|.+\|[ \t]*\n[ \t]*\|?[ \t]*:?-+/m],
  ["callout", /\[!(?:NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]/i],
  ["link", /\[[^\]\n]+\]\([^)\n]+\)/],
  ["quote", /^>[ \t]?\S/m],
  ["list", /^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+)\S/m],
  ["inlineCode", /`[^`\n]+`/],
  ["emphasis", /\*\*[^*\n]+\*\*|(?<!_)_[^_\n]+_(?!_)/],
];

export function markdownSignals(raw: string): MarkdownSignal[] {
  const text = raw.replace(/\r\n?/g, "\n");
  return TESTS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export function detectFormat(raw: string): Exclude<ImportFormatChoice, "auto"> {
  const signals = markdownSignals(raw);
  const strong = signals.filter((s) => STRONG.includes(s)).length;
  return strong >= 1 && signals.length >= 2 ? "markdown" : "plain";
}

/** 给导入表单做实时提示用，不参与判定。 */
export function describeSignals(raw: string): string {
  const labels: Record<MarkdownSignal, string> = {
    heading: "标题",
    fence: "代码块",
    table: "表格",
    callout: "提示框",
    link: "链接",
    quote: "引用",
    list: "列表",
    inlineCode: "行内代码",
    emphasis: "强调",
  };
  return markdownSignals(raw)
    .map((s) => labels[s])
    .join("、");
}

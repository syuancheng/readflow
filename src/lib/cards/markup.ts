/**
 * 墨墨语法的基础工具（P33 spec §6.1）。
 * 从旧的卡片生成模块挪来（旧导出功能已在 P33 删除），渲染器统一从这里拿。
 */

/** 普通文字里的 `[` `]` 必须转义，否则会提前闭合外层标签 */
export function esc(s: string): string {
  return s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** 压成一行：去掉真实换行、压缩连续空格，转义中括号 */
export function oneLine(s: string): string {
  return esc(
    s
      .replace(/\r/g, "")
      .replace(/[\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim(),
  );
}

/** 标签行的三种固定颜色（spec §6.1，取自设计规范） */
export const TAG_COLORS = {
  /** 题型标签：白字配绿底 */
  kindText: "!ffffff",
  kindBg: "!!58a700",
  /** 考试风格标签：紫字配浅紫底 */
  styleText: "!7a3cc0",
  styleBg: "!!f5ecff",
  /** 来源：灰字，不加底色 */
  source: "!888888",
  /** 原句高亮（蓝色） */
  highlight: "!1cb0f6",
  /** 解析重点（红色） */
  emphasis: "!e53935",
} as const;

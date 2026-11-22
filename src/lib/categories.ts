/**
 * 文章分类的唯一数据源。
 *
 * 分类是自由字符串（存库即原值，可空 = 未分类），但「可选分类」必须全端一致：
 * 预设分类写在这里，用户导入/编辑时新建的自定义分类从库里汇总。
 * 编辑弹窗、导入下拉、列表筛选都调用 allCategories() 取同一份全集，
 * 避免「这个界面有、那个界面没有」的漂移。
 */

/** 预设分类。顺序即界面展示顺序，改动只影响新文章的默认候选。 */
export const CATEGORIES = [
  "技术文档",
  "文学",
  "博客",
  "新闻",
  "论文",
  "教程",
  "其他",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** 分类名长度上限，与 API（POST/PATCH /api/texts）校验保持一致。 */
export const MAX_CATEGORY = 30;

/**
 * 分类候选全集 = 预设 + 库里出现过的自定义值（去重、预设在前）。
 *
 * @param used 库里已有的分类（文本行的 category，可为 null）
 * @returns 预设分类 + 不在预设中的自定义分类
 *
 * 注意：调用方若要「未分类」选项，自行在结果前拼 `null`；这里只管非空分类，
 * 因为「未分类」在库里是空值，不是分类名。
 */
export function allCategories(used: (string | null | undefined)[]): string[] {
  const custom = new Set<string>();
  for (const c of used) {
    if (c && !(CATEGORIES as readonly string[]).includes(c)) custom.add(c);
  }
  return [...CATEGORIES, ...custom];
}

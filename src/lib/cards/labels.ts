/**
 * 题型标签与 emoji 的映射（P33 spec §6.1）。
 * AI 不能决定卡面样式；题型名由 kind 决定，custom 用 AI 提供的 customLabel。
 */
export const KIND_LABELS: Record<string, { emoji: string; label: string }> = {
  // 全部是输出类：用户自己产出英文，背面给参考说法对照
  back_translate: { emoji: "🔁", label: "回译" },
  situation_say: { emoji: "💬", label: "情景说一句" },
  rephrase: { emoji: "🔀", label: "换个说法" },
  usage: { emoji: "🧩", label: "搭配与用法" },
  custom: { emoji: "✳️", label: "自定义" },
};

/** 拿题型标签；custom 且有 customLabel 时用它替换「自定义」 */
export function kindLabel(kind: string, customLabel?: string): { emoji: string; label: string } {
  const base = KIND_LABELS[kind] ?? KIND_LABELS.custom;
  if (kind === "custom" && customLabel && customLabel.trim()) {
    return { emoji: base.emoji, label: customLabel.trim().slice(0, 6) };
  }
  return base;
}

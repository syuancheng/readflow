/**
 * 题型标签与 emoji 的映射（P33 spec §6.1）。
 * AI 不能决定卡面样式；题型名由 kind 决定，custom 用 AI 提供的 customLabel。
 */
export const KIND_LABELS: Record<string, { emoji: string; label: string }> = {
  context_meaning: { emoji: "📖", label: "语境理解" },
  word_completion: { emoji: "✍️", label: "原句补全" },
  paraphrase_fill: { emoji: "🔄", label: "改写填空" },
  sentence_understanding: { emoji: "🧠", label: "整句理解" },
  true_false_ng: { emoji: "⚖️", label: "判断正误" },
  reference: { emoji: "👉", label: "指代" },
  collocation: { emoji: "🧩", label: "搭配" },
  listen_fill: { emoji: "🎧", label: "听句填空" },
  listen_choose: { emoji: "🎧", label: "听音选词" },
  layered_cloze: { emoji: "🪜", label: "分层提示" },
  paragraph_cloze: { emoji: "📄", label: "一段多空" },
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

/**
 * 讲解末尾「制卡建议」行的拆分（P33 spec §7.1，PRD F1）。
 * 纯函数；所有读取讲解内容的地方（gloss、词库显示、卡片）都必须先过它。
 */

/** 建议行必须以这个前缀开头（模型按系统提示词的约定输出） */
export const SUGGESTION_PREFIX = "制卡建议：";

/**
 * 理由建议 ≤30 个字（PRD F1），这个数字只写在给模型的提示词里。
 * 模型写长了也**完整显示、不截断**（用户 2026-11-13 决定）：截到半句话会让人看不懂。
 */
export const SUGGESTION_REASON_HINT = 30;

export type SplitResult = { body: string; suggestion: string | null };

/**
 * 只识别**最后一个非空行**，并且它必须以「制卡建议：」开头。
 * - 建议行在中间 → 不识别（那是正文，不是建议）。
 * - 多行都带前缀 → 只取最后一行（模型约定建议只出现在最后一行）。
 * - 只有建议行没有正文 → body 为空串。
 * - 理由原样返回（只去掉首尾空白），不按字数截断。
 */
export function splitCardSuggestion(text: string | null | undefined): SplitResult {
  if (!text) return { body: "", suggestion: null };
  const lines = text.split(/\r?\n/);
  // 找最后一个非空行
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return { body: "", suggestion: null };

  const last = lines[lastIdx].trim();
  if (last.startsWith(SUGGESTION_PREFIX)) {
    const reason = last.slice(SUGGESTION_PREFIX.length).trim();
    const suggestion = reason || null; // 前缀后没有内容 → 不当建议处理
    if (suggestion === null) return { body: text.trimEnd(), suggestion: null };
    return { body: lines.slice(0, lastIdx).join("\n").trimEnd(), suggestion };
  }
  return { body: text.trimEnd(), suggestion: null };
}

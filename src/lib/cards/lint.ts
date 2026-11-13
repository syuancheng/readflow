/**
 * 渲染结果的离线自检（P33 spec §6.1 末尾）。纯函数。
 * 从 cardgen.ts 的 lintCard 挪来，并补充：图片检查（§5.2 第 10 条）、
 * 分层提示卡的两条答案线、字数上限（§5.2 第 9 条）。
 */

export type LintOpts = {
  /**
   * 答案线条数：普通卡 1 条（正面 / 背面）；带提示层的卡 2 条
   * （正面 → 揭示提示 → 揭示答案，墨墨的「分层揭示」）。默认 1。
   */
  answerLines?: 1 | 2;
  /** 渲染结果的字数上限（UTF-16 码元，PRD Q7：普通 1800 / 专业 4000）；不传不检查 */
  charLimit?: number;
};

export function lintCard(content: string, opts: LintOpts = {}): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const lines = content.split("\n");
  const want = opts.answerLines ?? 1;

  const answerLines = lines.filter((l) => l.trim() === "---").length;
  if (answerLines === 0) problems.push("缺少答案线 ---");
  else if (answerLines !== want) {
    problems.push(want === 2 ? "分层提示卡需要两条答案线" : "答案线多于一条");
  }

  // 方括号配对（忽略转义）
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "[" && content[i - 1] !== "\\") depth++;
    else if (ch === "]" && content[i - 1] !== "\\") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) problems.push("方括号不配对");

  if (content.includes("**")) problems.push("残留 Markdown 加粗 **");
  if (content.includes("```")) problems.push("残留代码块围栏");
  if (/<[a-zA-Z/][^>]*>/.test(content)) problems.push("残留 HTML 标签");

  // 块级标签必须顶格
  for (const l of lines) {
    const t = l.trimStart();
    if (t !== l && /^\[(P|Choice|Pic|E)#/.test(t)) {
      problems.push(`块级标签未顶格：${t.slice(0, 20)}`);
      break;
    }
  }

  // P33 §5.2 第 10 条：卡片里不允许出现图片
  if (/\[Pic#/.test(content)) problems.push("卡片里不允许出现图片 [Pic#");

  // 选择块必须顶格开始、独占一行结束
  const choiceStart = lines.findIndex((l) => l.trimStart().startsWith("[Choice"));
  if (choiceStart >= 0) {
    if (lines[choiceStart] !== lines[choiceStart].trimStart() || lines[choiceStart] !== lines[choiceStart].trimEnd()) {
      problems.push("Choice 标签必须独占一行");
    }
    const closeIdx = lines.findIndex((l, i) => i > choiceStart && l.trim() === "]");
    if (closeIdx < 0) problems.push("Choice 缺少独占一行的闭合 ]");
  }

  // 未替换的音频占位符不能进入推送内容（草稿阶段允许，推送前由调用方替换）
  // —— 这里不检查，占位符在草稿里是合法的。

  if (opts.charLimit !== undefined && content.length > opts.charLimit) {
    problems.push(`卡片太长（${content.length} 字，上限 ${opts.charLimit} 字）`);
  }

  return { ok: problems.length === 0, problems };
}

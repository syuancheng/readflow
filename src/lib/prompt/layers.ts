/**
 * P57b：讲解提示词的分层装配（layout = v2）。设计见 docs/design/P57-PROMPT-CACHE-DESIGN.md。
 *
 *   L0 总纲     全站同一份，不随任何开关变化
 *   L1 用户层   个性化深度指引 + 讲解要求 + 稳定档案        （同一用户）
 *   L2 文章层   标题、分类                                   （同一篇文章）
 *   L3 段落层   前文末尾 + 当前段落                          （同一段内任意点击）
 *   L4 历史     同一批注里的往返问答
 *   L5 尾部     变体指令、易变档案、所在句、选区、观察、问题  （每次都变，不缓存）
 *
 * 前缀缓存要求「越稳定越靠前」：所有开关与变体（个性化、制卡、领域视角、拆句方法）只允许
 * 影响 L5 或只在整层存在/不存在上体现，**不得改动 L0**。每一层都是纯函数，输入只含该层依赖的数据。
 */
import {
  CARD_SUGGESTION_ZH,
  DEPTH_GUIDANCE_ZH,
  buildDomainSystemPrompt,
  buildSentenceStructureMethodPrompt,
  buildUserTail,
  historyTurns,
  legacySystemPrompt,
  type ExplainParams,
} from "../ai";
import type { ChatTurn } from "../providers";
import type { SentenceWindow } from "./sentence-window";

/** L0：中文人设 + 制卡建议规则。制卡开关关闭时由 L5 的一行指令抑制，这里永远带着 */
export function buildL0(): string {
  return `${legacySystemPrompt("en", false)}\n\n${CARD_SUGGESTION_ZH}`;
}

/** L1：个性化深度指引（仅个性化用户）+ 讲解要求 + 稳定档案；都为空则整层省略 */
export function buildL1(input: { personalized: boolean; teachingRules?: string; stableProfile?: string }): string {
  const parts: string[] = [];
  if (input.personalized) {
    parts.push(`【本学生的答案深度：以下指引替代上文「答案深度」那一段】\n${DEPTH_GUIDANCE_ZH}`);
  }
  if (input.teachingRules?.trim()) parts.push(input.teachingRules.trim());
  if (input.stableProfile?.trim()) parts.push(input.stableProfile.trim());
  return parts.join("\n\n");
}

/** L2：文章层（标题、分类）；没有则整层省略 */
export function buildL2(articleBlock?: string): string {
  const b = articleBlock?.trim();
  return b ? `【这篇文章】\n${b}` : "";
}

/** L3：上下文层（前文 + 所在句 + 同段后一句）。只含原文，与选区、问法、开关都无关 */
export function buildL3(win?: SentenceWindow): string {
  if (!win || !win.sentence.trim()) return "";
  const prev = win.prev.trim() ? `前文（背景，原文顺序）：\n${win.prev.trim()}\n\n` : "";
  const next = win.next.trim()
    ? `\n\n后一句（背景，同一段里紧接着的一句）：\n${win.next.trim()}`
    : "";
  return `【文章上下文：三处不同，别混用】
- 「所在句」是学生选中的词／短语直接所在的那句，是你要讲的对象：词义、搭配、句法都以它为准。
- 「前文」只用来理解 that / it / the one 这类指代、承接与省略。
- 「后一句」只在所在句要靠后文才讲得通时才用（比如 "This is because…" 的原因在后面）。
前文和后一句都是背景，不是学生选中的内容：不要把它们翻译成中文，也不要把它们当成学生的问题。

${prev}所在句（讲的对象）：
${win.sentence.trim()}${next}`;
}

/** L5 里的变体指令（只写需要的，没有就是空串） */
export function buildVariantBlock(params: ExplainParams): string {
  const lines: string[] = [];
  if (params.cardsEnabled === false) lines.push("本次不要输出「制卡建议」行。");
  if (params.askKind === "domain") {
    lines.push(
      `【本轮改换视角：忽略上文英语老师人设里关于「释义行、句子地图、答案深度、制卡建议」的要求，只按下面的要求回答】\n${buildDomainSystemPrompt()}`,
    );
  }
  if (params.askKind === "structure") lines.push(buildSentenceStructureMethodPrompt());
  return lines.join("\n\n");
}

/** v2：完整 messages */
export function assembleExplain(params: ExplainParams): ChatTurn[] {
  const l1 = buildL1({
    personalized: params.personalized === true,
    teachingRules: params.teachingRules,
    stableProfile: params.learnerStable,
  });
  const l2 = buildL2(params.articleBlock);
  const l3 = buildL3(params.sentenceWindow);
  return [
    { role: "system", content: buildL0() },
    ...(l1 ? [{ role: "system" as const, content: l1 }] : []),
    ...(l2 ? [{ role: "system" as const, content: l2 }] : []),
    ...(l3 ? [{ role: "system" as const, content: l3 }] : []),
    ...historyTurns(params.history, { blockSize: HISTORY_BLOCK }),
    { role: "user", content: buildUserTail(params, buildVariantBlock(params)) },
  ];
}

/** L4 历史压缩的分块大小：每攒满 3 轮才压缩一批，压后不再改 */
export const HISTORY_BLOCK = 3;

/** 客户端只传了两层上下文（没有 textId / 锚点）时的回退：折成句子窗口，结构仍是 v2（没有后一句） */
export function windowFromLayers(layers: { sentence: string; nearContext: string[] }): SentenceWindow {
  return {
    prev: [...layers.nearContext].reverse().join(" "),
    sentence: layers.sentence,
    next: "",
  };
}

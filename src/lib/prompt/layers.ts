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
import type { ParagraphWindow } from "./paragraph-window";

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

/** L3：段落层。只含段落原文，与选区、问法、开关都无关 */
export function buildL3(win?: ParagraphWindow): string {
  if (!win || !win.body.trim()) return "";
  const prev = win.prevTail.trim()
    ? `前文（背景，原文顺序）：\n${win.prevTail.trim()}\n\n`
    : "";
  return `【文章原文：背景，不是学生的问题】
学生选中的词／短语所在的句子，会在最后一条消息里单独给出，那才是你要讲的对象。下面的原文只用来理解指代（that / it / the one）、承接、省略和上下文语气：其中没被选中的句子不要翻译，也不要当成学生的问题；后面的句子只在「当前句要靠后文才讲得通」时才用。

${prev}当前段落：
${win.body.trim()}`;
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
  const l3 = buildL3(params.paragraphWindow);
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

/** 客户端只传了两层上下文（没有 textId / 锚点）时的回退：把它折成一个窗口，结构仍是 v2 */
export function windowFromLayers(layers: { sentence: string; nearContext: string[] }): ParagraphWindow {
  return {
    prevTail: [...layers.nearContext].reverse().join(" "),
    body: layers.sentence,
    sentence: layers.sentence,
  };
}

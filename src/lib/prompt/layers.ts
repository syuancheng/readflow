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

/**
 * 答案深度（v2 唯一一份）：有没有档案都用同一段文字，不再有「默认版」和「个性化版」两份。
 * 没有档案时按选区判断（原默认规则）；有档案时按档案、反馈、观察判断（原个性化指引）。
 * 档案本身在后面的消息里：稳定部分在用户层，近况在最后一条消息的「学生近况」里。
 */
// 函数而不是常量：layers 与 ai 互相引用，模块加载时 ai 里的常量可能还没初始化
function v2Depth(): string {
  return `【答案深度由你判断，不要问我】
先看后面的消息里有没有「学生档案」或「学生近况」：
- 没有：只按选区本身判断，讲到这一层就停。选区是边缘成分 → 轻答：意思 + 一句为什么，1~2 句，不写句子地图；选区是主干成分，或涉及被动语态、倒装、从句 → 中答：意思 + 为什么 + 句子地图。不主动写「整句大意：」——学生需要整句时会自己点「整句没看懂」或「讲讲句子结构」。
- 有：按下面的方式判断。
${DEPTH_GUIDANCE_ZH.split("\n").slice(1).join("\n")}`;
}

/**
 * 特殊问法「从内容角度讲讲这句」（v2：作为 L0 里的一节，由最后一条消息的触发行启用）。
 * 原来是整套换成另一个人设；换人设会让 system 的第一个字符就不同，整条缓存作废。
 * 现在人设永远是同一份，这一节写明「只有触发行出现时才用，且上文的释义行、句子地图等不适用」，不靠一句「忽略上文」覆盖。
 */
export const DOMAIN_TRIGGER = "【本轮：从内容角度讲讲这句】";

/**
 * 特殊问法「学生自己提问」（askKind = custom）：通过输入框自己发消息或点自定义常用问题。
 * 规则静态写在 L0（保证所有请求 L0 逐字相同、缓存命中），由 L5 尾部的 CUSTOM_TRIGGER 触发，
 * 解除默认词义讲解的「第一行写释义：」「只答选区、不译选区外」「主干必画句子地图」束缚，正面回答学生的问题。
 */
export const CUSTOM_TRIGGER = "【本轮：直接回答学生自己提出的问题】";

function customAskSection(): string {
  return `【特殊问法：学生自己提问】
只有当最后一条消息含「${CUSTOM_TRIGGER}」时才用本节。此时学生不是让你按默认模板讲选区词义，而是自己在输入框里向你提了一个具体问题（或说出了他对这句话的理解／猜测请你确认）：
- 第一优先级是**直接、正面回答「学生的问题」**，不要套用默认的词义讲解模板。
- 如果学生在核对自己的理解或猜测（例如「我猜这句话的意思是…」「是不是指…」），**第一句话先明确回应他的理解对不对**：说对的部分直接肯定，有偏差、漏掉或修饰关系看错的地方精准点出，再补上必要的解释。
- **不要写第一行「释义：」**（除非学生在问题里明确要求你给「释义：」行），第一句话直接回应他。
- **不受「只答选区、不译选区外」的限制**——他虽然点在某个词上，但如果问的是半句、整句或上下文的意思，就按他问的范围正面作答，不算越界。
- 除非他问到了句子结构，或者他的误读正好是把句子主干／修饰关系看错了，否则不要例行公事画句子地图。`;
}

function domainModeSection(): string {
  const body = buildDomainSystemPrompt();
  const i = body.indexOf("【你收到的信息】");
  const j = body.indexOf("【第一步");
  if (i < 0 || j < 0) throw new Error("domain prompt markers changed");
  const info = `【你收到的信息】
标题与分类在「【这篇文章】」那条消息里（可能只有一项，也可能没有）；学生选中的是一整个句子，在最后一条消息的「所在句」里，那就是你要讲的对象。

`;
  return `【特殊问法：从内容角度讲讲这句】
只有当最后一条消息以「${DOMAIN_TRIGGER}」开头时才用本节。那一轮你不再是英语老师：上文关于「释义行、句子地图、答案深度、制卡建议」的要求一律不适用，完全按本节回答；其余各轮照常，不要把本节用到别的问法上。

${body.slice(0, i)}${info}${body.slice(j)}`;
}

/** L0：中文人设 + 唯一一份答案深度 + 制卡建议规则 + 特殊问法。所有开关与变体都不改这一层 */
export function buildL0(): string {
  const base = legacySystemPrompt("en", false);
  const i = base.indexOf("【答案深度】");
  const j = base.indexOf("【硬性禁止】", i);
  if (i < 0 || j < 0) throw new Error("persona depth markers changed");
  const persona = `${base.slice(0, i)}${v2Depth()}\n\n${base.slice(j)}`;
  return `${persona}\n\n${CARD_SUGGESTION_ZH}\n\n${domainModeSection()}\n\n${customAskSection()}`;
}

/** L1：讲解要求 + 稳定档案；都为空则整层省略 */
export function buildL1(input: { teachingRules?: string; stableProfile?: string }): string {
  const parts: string[] = [];
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
  if (params.askKind === "domain") lines.push(DOMAIN_TRIGGER);
  if (params.askKind === "structure") lines.push(buildSentenceStructureMethodPrompt());
  if (params.askKind === "custom" && params.prompt) lines.push(CUSTOM_TRIGGER);
  return lines.join("\n\n");
}

/** v2：完整 messages */
export function assembleExplain(params: ExplainParams): ChatTurn[] {
  const l1 = buildL1({
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

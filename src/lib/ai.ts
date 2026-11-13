import { resolveProvider, STREAM_RESET, type EnvMap, type SettingsMap } from "./config";
import { allSettings } from "./settings-store";
import { backoffDelayMs, DEFAULT_RETRY, isRetryableError } from "./retry";
import { streamChat, type ChatTurn } from "./providers";
import type { SelectionSignals } from "./sentence";
import { NO_MODEL_NOTICE } from "./explain-policy";
// 保留原有导入路径：/api/summarize 仍从 lib/ai 取这段提示
export { NO_MODEL_NOTICE };

/**
 * AI 释义：模型与 Key 由「配置中心」决定（设置页可配 DeepSeek / OpenAI /
 * Claude / 千问 / 任意 OpenAI 兼容端点，勾选哪个用哪个）。
 *
 * 2026-11-05 重构：取消三段式固定模板，改成「一个老师 + 一组证据 + 一个回答」。
 * 2026-11-06 再改（P13）：修掉「为了不给整句译文，模型退回去只讲语法」的偏差。
 * 2026-11-07 P14：同句二次/三次分支 + priorAsks 信号。
 * - 人设：英语为母语且懂中文的英语老师，能预判中文母语者的干扰点。
 * - **按范围给，不按内容禁**：第一屏给「选中部分在这句话里的意思」，选区多大就译多大
 *   （选整句就译整句），但不要把选区外的英文顺手译出来。旧的「禁止整句译文」全部删掉。
 * - **同句二次扩面**：第 2 次且选区不重叠 → 先给「整句大意：」标记的一句概括再给选区意思，不重复上轮。
 * - **同句三次整句**：第 3 次及以上 → 先「整句大意：」概括 → 选区细节 → 句子地图。
 * - 整句大意用专属标记「整句大意：」且与 P13 的「整句在说：」逐字翻译禁令区分（一个是授权概括，一个是越界）。
 * - priorAsks 信号：把同句之前问过的选区文本送过去，让模型判断是并列还是同词复用。
 * - 语义是主体，语法是配角：第一段不许堆语法术语；结构分析殿后、可选、符号化。
 * - 句子地图从「每个成分挂括号」改成「只把主干用 ==...== 标下划线，其余原样保留」；
 *   P15 进一步：主干用「==成分：原文==」标记，渲染成下划线主干 + 正下方成分小标签（方案 B）。
 * - 前端只送客观信号（SelectionSignals），判断句法权重与答案深度是模型本职，不在前端分类。
 * - 默认释义与 Ask AI 追问共用同一套 system，只有「学生的问题」一行不同。
 * - 流式输出（SSE）、网络错误 / 限流统一重试，重试用 STREAM_RESET 通知前端清屏。
 */

/** 当前生效的配置（服务端读本地 DB + 环境变量兜底） */
export function currentSettings(): SettingsMap {
  return allSettings();
}

/** 这次调用用谁的模型配置（P28：按账号区分，见 lib/user-secrets.ts）；不传 = 站级配置 */
export type AiConfig = { settings: SettingsMap; env: EnvMap };

export type ExplainParams = {
  word: string;          // 要解释的词或短语（选区）
  context: string;       // 兜底上下文（旧调用只传一句话时使用）
  prefix?: string;       // 选区在段内的前文（可为空）
  suffix?: string;       // 选区在段内的后文（可为空）
  language?: string;     // 目标语言（正在学的语言），默认 en
  monolingual?: boolean; // true = 用目标语言解释，false = 用中文解释
  prompt?: string;       // 用户的自定义追问（对应 Readlang 的 askAI）
  withPrevSentence?: boolean; // 前文已包含上一句（「没看懂整句」信号触发），给模型加衔接提示
  /** 阅读器采集的客观信号（不是结论）。旧调用不带时模型仍可正常工作。 */
  signals?: SelectionSignals;
  /** P32：服务端合成的学生档案文本，插在 user 消息最前面；空串时不插入任何内容 */
  learnerBlock?: string;
  /** P32：个性化讲解开关。为假时系统提示词逐字保持旧规则 */
  personalized?: boolean;
  /** P32：偏好「讲细一点」时把 maxTokens 放到 600，其余保持 400 */
  detailed?: boolean;
  /** P33：服务端记事件用，不发给模型 */
  askKind?: string;
  contextId?: string;
  textId?: string;
  /** P33：观察信息——这个词在其他文章里查过 N 次（只统计别的 text_id） */
  otherTextLookups?: number;
  /** P33：观察信息——这个词已推送过卡片（取值同 explain_events.carded_before） */
  cardedBefore?: boolean;
  /** P33：做卡开关关闭时不追加制卡建议段（服务端在 handleExplain 里决定） */
  cardsEnabled?: boolean;
};

/**
 * 构建 system prompt。
 *
 * 新契约（2026-11-05 讨论收敛）：一套人设，不再按 word / phrase / sentence 分叉。
 * 保留第三个参数 word 只是为了兼容旧调用与单测；system 不随选区改变，
 * 这本身就是一条可单测的性质——同一个老师，不会因选区长度换人格。
 */
/**
 * P32：个性化讲解的深度指引（中文人设）。逐字取自实现说明 §5.3。
 * 只替换「答案深度」那一段，其余提示词一个字都不动——开关关闭时就是回退保障。
 */
const DEPTH_GUIDANCE_ZH = `【答案深度由你判断，不要问我】
根据「学生档案」和「观察」判断讲多深：L1 只给这句里的意思；L2 加上在这句里怎么理解或搭配；L3 再加「整句大意：」一句话概括；L4 再加句子地图，必要时给一个例句。拖选长片段、档案显示长句是难点时往深处走；档案显示水平高、偏好简洁、以往反馈「太深」偏多时往浅处走。「之前问过的选区」只用来避免重复讲同一内容，不决定讲多深。偏好简洁的学生最多加「整句大意：」，不主动画句子地图。阅读目的会影响义项选择（例如技术文档读者优先给技术含义）。不论讲多深，第一行永远是「释义：」。
判断句法角色、两次选区是否重叠是老师的本职；不要输出判断过程，直接用答案体现。`;

/** monolingual 人设的等义英文指引（文档只给了中文段落，这里保持两套人设行为一致） */
const DEPTH_GUIDANCE_EN = `Depth is yours to judge from the observations and the "student profile":
L1 gives only the meaning in this sentence; L2 adds how to read or pair it here; L3 adds a one-sentence "整句大意：" whole-sentence meaning; L4 adds a sentence map and, if needed, one example. Go deeper when the student selected a long span, or the profile shows long sentences are a weak point. Go lighter when the profile shows a high level, a preference for brevity, or mostly "太深" feedback. The "prior asks" are only for avoiding repetition, not for deciding depth. A student who prefers brevity gets at most the one-line whole-sentence meaning — never volunteer a sentence map unless they ask for structure. The reading goal affects which sense you choose (a technical reader gets the technical meaning of "artifact"). Keep the prose short and answer exactly the selection. Do not output your reasoning.`;

function personalizeDepth(prompt: string, monolingual: boolean): string {
  const start = monolingual
    ? "Depth is yours to judge from the observations,"
    : "【答案深度由你判断，不要问我】";
  const end = monolingual ? "Never: phonetic symbols" : "【硬性禁止】";
  const i = prompt.indexOf(start);
  const j = i < 0 ? -1 : prompt.indexOf(end, i);
  if (i < 0 || j < 0) return prompt; // 找不到就原样返回，绝不破坏旧行为
  const guidance = monolingual ? DEPTH_GUIDANCE_EN : DEPTH_GUIDANCE_ZH;
  const swapped = prompt.slice(0, i) + guidance + "\n\n" + prompt.slice(j);
  return dropRepeatCountRules(swapped, monolingual);
}

/**
 * 个性化模式下，核心规则里「同句第 N 次就给整句大意」的旧例外也要去掉，
 * 否则它和档案判断同时生效、互相抢话。保留「整句大意必须是概括、不能逐字翻译」的约束。
 * 任何一处找不到就原样保留（绝不破坏旧行为）。
 */
const REPEAT_RULE_SWAPS: { zh: [string, string][]; en: [string, string][] } = {
  zh: [
    [
      "  · 例外：同句已问过 ≥2 次时，第一屏先给整句大意再给选区意思——见下方「答案深度」段。",
      "  · 例外：按下方「答案深度」判断需要整句大意时，第一屏先给整句大意再给选区意思。",
    ],
    [
      "  · 例外：同句第 2 次且选区不重叠、或第 3 次及以上时，可以给整句大意——但必须用「整句大意：」这个标记开头，",
      "  · 例外：按下方「答案深度」判断需要整句大意时，可以给整句大意——但必须用「整句大意：」这个标记开头，",
    ],
    [
      "- 即使同句已问过多次、要先写「整句大意：」，第一行也仍然是「释义：」这一行，「整句大意：」放在它下面。",
      "- 即使要先写「整句大意：」，第一行也仍然是「释义：」这一行，「整句大意：」放在它下面。",
    ],
  ],
  en: [
    [
      "   · Exception: when this is the 2nd+ ask on the same sentence, open with a whole-sentence meaning first — see Depth below.",
      "   · Exception: when the Depth judgment below calls for it, open with a whole-sentence meaning first.",
    ],
    [
      "   · Exception: on 2nd ask (non-overlapping) or 3rd+ ask, you may open with whole-sentence meaning — but label it",
      "   · Exception: when the Depth judgment below calls for it, you may open with whole-sentence meaning — but label it",
    ],
  ],
};

function dropRepeatCountRules(prompt: string, monolingual: boolean): string {
  let out = prompt;
  for (const [from, to] of monolingual ? REPEAT_RULE_SWAPS.en : REPEAT_RULE_SWAPS.zh) {
    if (out.includes(from)) out = out.replace(from, to);
  }
  return out;
}

/**
 * P33（spec §7.1）：制卡建议规则，追加在系统提示词末尾。
 * 个性化开关打开和关闭时都追加（PRD 规定两者互不依赖）——「P32 快照逐字不变」
 * 指的是讲解深度那部分，制卡建议是 P33 新增的，快照测试同步更新（用户已确认）。
 */
const CARD_SUGGESTION_ZH = `【制卡建议（可选，只在最后一行）】
回答结束后，如果你认为这个词值得做成记忆卡，在最后一行输出：
制卡建议：<理由，一句话不超过 30 个字>
- 值得做：正好在他词汇量的边缘；和他的阅读目的相关；在不同文章里第二次遇到；是值得掌握的搭配或短语。
- 不值得做：专有名词、产品名、人名；对他太简单（多半是一时没反应过来）；太生僻、以后基本遇不到。
- 不值得做时什么都不输出；建议行之后不能再有任何内容。`;

const CARD_SUGGESTION_EN = `Card suggestion (optional, last line only):
After the answer, if you think this word is worth turning into a flashcard, output one final line:
制卡建议：<reason, one clause, at most 30 characters>
- Worth it: at the edge of the student's vocabulary; relevant to their reading goal; a second encounter across articles; a collocation worth mastering.
- Not worth it: proper nouns, product names, people's names; too easy for them; too rare to meet again.
- Output nothing when not worth it. Nothing may follow this line.`;

/** 导出供单测断言输出结构（不对外承诺稳定性） */
export function buildSystemPrompt(
  language: string,
  monolingual: boolean,
  _word: string,
  opts?: { personalized?: boolean; cardsEnabled?: boolean },
): string {
  const base = legacySystemPrompt(language, monolingual);
  const depth = opts?.personalized ? personalizeDepth(base, monolingual) : base;
  // P33：默认追加（cards.enabled 默认 on）；显式传 false 才不追加
  return opts?.cardsEnabled === false
    ? depth
    : `${depth}\n\n${monolingual ? CARD_SUGGESTION_EN : CARD_SUGGESTION_ZH}`;
}

/** 旧提示词原样保留：开关关闭时逐字返回，不做任何「顺手优化」 */
function legacySystemPrompt(language: string, monolingual: boolean): string {
  if (monolingual) {
    return `You are a native ${language} teacher who also understands Chinese. Your student is a Chinese native speaker reading a real ${language} text and has selected a piece of it to ask about. Knowing Chinese means you can anticipate where Chinese speakers misread ${language}: tense, articles, prepositions, polysemy, clause structures Chinese lacks, tone and register.

Your only job: explain what the selected text means in the sentence it appears in, so the student can keep reading.

Core rule — answer exactly the selection:
1) The first paragraph is the main body. Open with the meaning of the selected text IN THIS SENTENCE — a contextual rendering, not a list of dictionary senses. For example, "over rich states and artifacts" here means "control over the rich states and artifacts", not "above"; "benefits from" means "gains from", not the noun "benefits"; "recurring" means only what it means here.
   · Exception: when this is the 2nd+ ask on the same sentence, open with a whole-sentence meaning first — see Depth below.
2) Translate as much as the student selected, no less and no more: a whole sentence selected → give that sentence's meaning; a single word → just that word. Do not hold back out of fear of "giving the answer" — they chose the range themselves. But never translate the surrounding English that was NOT selected.
   · Exception: on 2nd ask (non-overlapping) or 3rd+ ask, you may open with whole-sentence meaning — but label it "整句大意：" (whole-sentence meaning) and make it a one- to two-sentence PARAPHRASE of what the sentence is about, NOT a word-for-word translation of the unselected English.
   Unless the selection IS the whole sentence, never use "The sentence is saying..." / "In other words..." / "Here it says..." to introduce a rendering of the unselected part — that goes beyond the range. State direction only: what it pairs with, which way the action goes, without restating the original content. Example (selection "benefits from"): "gains from"; from introduces the source of the benefit, A benefits from B means A improves because of B. When writing whole-sentence meaning on a later ask, use the "整句大意：" label above — do not use the banned "The sentence is saying..." phrasing.
3) Then, in the fewest words, remove the one or two things most likely to have blocked them: why this sense, how the phrase or preposition reads, what a reference points to, how an inversion or ellipsis resolves. Let them read on themselves; do not restate the whole sentence in other words. No dictionary sense lists, no grammar terminology pile-up, no restating the selection. When the same sentence was asked before, do not repeat what a prior ask already covered.
4) Optional second line: one sentence locating what role the selection plays. Light answers may omit it.

Last, and only when needed: a "sentence map" in 2–3 symbolic lines. Lead with an emoji + pattern label (for example 🧩 SVC · predicative with a relative clause), then the original sentence with ONLY the backbone wrapped in ==role: text== so the role renders as a small label right under the underlined backbone — leave every other constituent untouched, do not label them one by one with brackets. Use Chinese role labels: 主语 subject / 谓语 verb / 宾语 object / 表语 predicative / 状语 adverbial. Example: ==主语：A recurring pattern== ==谓语：is== ==表语：simple control== over rich states and artifacts. Then optionally one ⚠️ pitfall or 🔗 reference line. For long sentences elide the rest with … and say what was elided. Unsure constituents get "(uncertain)" — never guess. If the structure is unclear, omit the map entirely. Never label a noun inside the predicate as the sentence subject; a wrong backbone is worse than no map.

Depth is yours to judge from the observations, which include "repeat count" and "prior asks" (what they asked about before in this same sentence). Judge accordingly:
- First ask: a peripheral modifier → light (meaning + one line of why, no map); a backbone constituent, passive, inversion or clause → include the map.
- Second ask on the same sentence, and this selection does NOT overlap the prior one: the student has two separate blockers and needs the sentence-level frame. Open with a line labelled "整句大意：" giving ONE sentence of whole-sentence meaning (a PARAPHRASE of what the sentence is about, NOT a word-for-word translation), then give this selection's meaning and its role in the sentence. Do not repeat what the prior ask already covered. Include the map if needed. This is "broaden the frame."
  · But if this selection overlaps the prior one (re-asking the same spot from a different angle), treat it like a first ask — just go deeper on that word itself.
- Third or later ask on the same sentence: the sentence is genuinely hard. Open with "整句大意：" giving whole-sentence meaning (one to two sentences, a paraphrase not a word-for-word translation), then this selection's meaning and why, then the map to locate the whole backbone; note that unfamiliar words are dense. Order: whole-sentence meaning → detail → map.
Do not output your reasoning.

Never: phonetic symbols, greetings, fixed three-section headings, numbered lists, Markdown headings, tables, code fences, HTML, a grammar lecture as the first paragraph, a "The sentence is saying..." restatement that goes beyond the selection, or section labels like "Second line:" — the paragraph order above is an instruction for you, not a heading for the student. The map relies on emoji, ==...== underlines and line breaks; avoid heavy bold markup, which flickers mid-stream. Keep the prose under 120 words; the labelled English sentence does not count. Answer in ${language.toUpperCase()}.`;
  }

  return `你是一位英语为母语、并且懂中文的英语老师。学生是中文母语者，正在读一篇真实的英文文章，他选中了一段文字停下来向你请教。你懂中文的价值在于：能预判中文母语者容易误读的地方——时态、冠词、介词、一词多义、中文里没有的从句结构、语气与语体。

你只有一个任务：把学生选中的那部分，在它所在句子里的意思讲清楚，让他能继续往下读。

【你收到的信息】
用户消息里有「用户选中」「前文」「后文」「所在句子」，以及一组「观察」——那是阅读器采集的客观信号，不是结论。判断由你来做。

【第一行：固定格式的中文释义（必须）】
- 回答的第一行永远是「释义：」加上选中部分在这句话里最直接、最准确的中文意思，例如「释义：超智能的」「释义：受益于」「释义：调用大模型的」。
- 这一行只写中文意思本身：不加引号、不加解释、不加破折号、不写英文原词；单词或短语尽量 8 个字以内。选区是整句时，这一行就是整句的中文翻译。
- 这一行会原样显示在正文里那个词的正上方，所以它必须能单独成立。所有解释从第二行开始写。
- 即使同句已问过多次、要先写「整句大意：」，第一行也仍然是「释义：」这一行，「整句大意：」放在它下面。

【核心规则：只答选中的那一段】
- 「用户选中」就是学生这次要问的范围。第一屏（「释义：」那一行之后）先把「选中部分在这句话里的中文意思」讲透——按这句的语境译，不是搬词典义项。例如选中 over rich states and artifacts，给「对丰富的状态与产物（的控制）」而不是「在…之上」；选中 benefits from，给「受益于」而不是「好处」；选中 recurring，只给这句里「反复出现的」这一个意思。
  · 例外：同句已问过 ≥2 次时，第一屏先给整句大意再给选区意思——见下方「答案深度」段。
- 选区多大就译多大：选区是一整个句子，就把这一句译出来；是一个词，就只给这个词。不要因为怕「直接给答案」而克制、改给半句或只给主干概括——范围由学生自己划定，这正是他要的。
- 但不要把选区以外、前后文里没被选中的英文也顺手译成中文。译的是选区，不是整段。
  · 例外：同句第 2 次且选区不重叠、或第 3 次及以上时，可以给整句大意——但必须用「整句大意：」这个标记开头，且是**概括一句话**（约一两句中文讲清这句在讲什么），不是逐字对译选区外的英文。见下方「答案深度」段。
- 选区不是整句时，不要用「整句在说：」「整句说的是：」「这里说的是：」「整句在讲」这类句式把没选中的英文逐字译成中文——那等于把没选中的英文也译了，是越界。要讲方向，只说它跟谁搭配、动作朝哪个方向，不复述原句内容。
  正例（选区 benefits from）：「受益于」。from 引出好处的来源，A benefits from B 是「A 因 B 变好」，别读反；benefits 在这里是动词，不是名词「好处」。
  · 二次/三次要写整句大意时，用上面说的「整句大意：」标记，不要套用「整句在说：」等禁用句式——它们一个是授权概括，一个是越界逐字译，别混。
- 给完意思，再用最短的中文点破他最可能卡住的一两件事：为什么是这个词、搭配或介词怎么读、指代指向谁、倒装或省略还原后怎么接下去。让他自己把这一句读下去。
- 一次只答最要紧的一两件事；不复述选区、不罗列词典义项、不堆语法术语。同句已问过时，不要重复讲上一轮已经覆盖过的内容。

【第二段（可选，一句话）】
用一句话说清选中的部分在句里充当什么，帮他定位即可，不要展开成语法讲解。轻答可以完全不写这一句。

【第三段，只有需要时才写，且永远殿后——「句子地图」】
- 2~3 行符号化排版，把原句放出来，让学生一眼扫到主干。详细靠标记密度，不靠字数，不要写成语法讲义。
- 第 1 行：emoji + 句型标签，例如「🧩 主系表 · 表语带介词短语」。
- 第 2 行：原句照抄，只把主干（主语、谓语／系动词、宾语／表语）用「==成分：原文==」包起来——冒号前写成分名（主语／谓语／宾语／表语／状语…），冒号后紧跟原句原文，渲染时成分名会变成主干正下方的小标签，主干本身仍是下划线。其余成分（定语、状语、插入语）保持原样、不要逐个挂括号标注。例如「==主语：The opposite problem== ==系动词：is== ==表语：the classifier repeatedly stopping something== that's routine in your setup.」——that's routine 这类修饰语留原样，不标。
- 第 3 行（可选）：⚠️ 易错点，或 🔗 指代／衔接提示，一行说完。
- 长句可只保留主干附近，其余用 … 省略，并在括号里点一句省掉的是什么。
- 成分没把握就标「（存疑）」，宁可不标也不硬编；整句结构拿不准时，句子地图直接不写。尤其别把表语／修饰语里的名词误标成全句主语——主干标错比不标更糟。

【答案深度由你判断，不要问我】
观察块里有「同句连续请教」次数和「之前问过的选区」——它们告诉你这句被问过几次、每次问的是什么。据此判断深度：
- 第 1 次请教：
  · 选区是边缘成分 → 轻答：意思 + 一句为什么，1~2 句，**句子地图不写**。
  · 选区是主干成分，或涉及被动语态、倒装、从句 → 中答：意思 + 为什么 + 句子地图。
- 第 2 次请教（同句已问过 1 次），且本次选区与之前问过的选区不重叠：
  说明这句有两个卡点，学生需要整句框架。第一屏用一行「整句大意：」给出这句话的一句话概括（是概括，不是逐字对译——约一两句中文讲清这句在讲什么），再给本次选区的意思，并说清它在整句里充当什么。不要重复讲上一轮已经覆盖过的那个词。句子地图按需给。这是「二次扩面」——用框架帮他把两个卡点挂回去。
  · 但如果本次选区与上次重叠（比如同句换了个角度再问同一个词），不算扩面，按第 1 次的深度走，只是可以更深挖这个词本身。
- 第 3 次及以上（同句已问过 ≥2 次）：
  说明这句确实难。第一屏用「整句大意：」给出整句的一句话概括（一两句，是概括不是逐字翻译），再给本次选区的意思和为什么，最后给句子地图帮他定位整句主干，并说明生词较密。顺序是「整句大意 → 选区细节 → 地图」。
判断句法角色、两次选区是否重叠是老师的本职；不要输出判断过程，直接用答案体现。

【硬性禁止】
- 不输出音标、寒暄、「希望有帮助」；不使用旧版那种固定三节小标题，不写编号列表。
- 第一段不堆语法术语、不写成语法讲义；不把语法分析放到第一段。
- 选区不是整句时，不写「整句在说：」「整句说的是：」「这里说的是：」这类把没选中的英文逐字复述成中文的句子；这是越界，不是释义。二次/三次要写整句大意，用「整句大意：」标记，不要用这里的禁用句式。
- 「第一段／第二段／第三段」是给你组织答案的说明，不要写成「第二段：」这类段落标签。
- 不使用 Markdown 标题、表格、代码块、HTML；除 ==主干== 外尽量少用加粗（流式渲染时未闭合的星号会闪）。
- 用中文作答，英文原词、例句与被标注的原句保留英文。
- 中文说明控制在 150 字以内；长难句或重答可到 180 字。被标注的英文原句不计入。宁可少说一件事，不要每件事讲半句。`;
}

/**
 * 构建 user message。
 * 默认释义与 Ask AI 追问共用同一套 system 和同一个上下文块，只有「学生的问题」一行不同：
 * 默认时把「判断卡在哪」交给老师，追问时换成用户自己的问题。
 */
/** 导出供单测做控制变量断言 */
export function buildUserMessage(params: ExplainParams): string {
  const question = params.prompt
    ? `学生的问题: ${params.prompt}`
    : "学生没有说出具体问题。请根据选区、所在句子和观察，判断他卡在哪里，然后直接回答。";
  // P32：学生档案放在最前面；为空时不插入任何字符，旧调用的输出逐字不变
  const learner = params.learnerBlock?.trim() ? `${params.learnerBlock.trim()}\n\n` : "";
  return `${learner}${contextBlock(params)}
${question}`;
}

/** 组装「选中/前文/后文」上下文块，并附上阅读器采集的客观信号 */
function contextBlock(params: ExplainParams): string {
  const { word, context, prefix, suffix, withPrevSentence } = params;
  let base: string;
  if (typeof prefix === "string" || typeof suffix === "string") {
    const pre = (prefix ?? "").trim();
    const suf = (suffix ?? "").trim();
    const hint = withPrevSentence
      ? "\n（提示：前文开头是选区所在句的上一句，可用于理解指代、承接等句间衔接。）"
      : "";
    base = `用户选中: "${word}"
前文: ${pre ? `"${pre}"` : "（无）"}
后文: ${suf ? `"${suf}"` : "（无）"}${hint}`;
  } else {
    base = `用户选中: "${word}"
所在句子: "${context}"`;
  }
  const obs = observations(params);
  return obs ? `${base}\n\n${obs}` : base;
}

/** 只摆客观证据，不下结论——判断句法权重与答案深度是模型的事 */
function observations(params: ExplainParams): string {
  const signals = params.signals;
  if (!signals) return "";
  const lines: string[] = [];
  lines.push(`- 操作: ${signals.source === "word" ? "点了一个词" : "拖选了一段"}`);
  lines.push(
    `- 选区 ${signals.selectionWords} 词；所在句 ${signals.sentenceWords} 词；覆盖约 ${Math.round(signals.coverage * 100)}%`,
  );
  const pos =
    signals.position === "start" ? "句首" : signals.position === "end" ? "句末" : "句中";
  lines.push(`- 选区位置: ${pos}`);
  const sentence = signals.sentence.trim();
  if (sentence) lines.push(`- 所在句子原文: "${sentence}"`);
  if (typeof signals.dictHit === "boolean") {
    lines.push(`- 词典: ${signals.dictHit ? "已收录" : "未收录"}`);
  }
  // 个性化模式下深度由档案判断，不再把「同句第几次」交给模型（没有档案时本请求按旧规则走，仍带次数）
  if (!params.personalized && typeof signals.repeatCount === "number" && signals.repeatCount > 0) {
    lines.push(`- 同句连续请教: 第 ${signals.repeatCount} 次`);
  }
  if (signals.priorAsks && signals.priorAsks.length > 0) {
    const items = signals.priorAsks.map((a) => `"${a.selection}"`).join("、");
    lines.push(`- 之前问过的选区: ${items}`);
  }
  // P33（spec §7.1）：做卡相关的两条观察
  if (typeof params.otherTextLookups === "number" && params.otherTextLookups > 0) {
    lines.push(`- 这个词在其他文章里也查过 ${params.otherTextLookups} 次`);
  }
  if (params.cardedBefore) {
    lines.push(`- 这个词已经做过卡（已推送到墨墨）`);
  }
  return `观察（客观信号，不是结论）：\n${lines.join("\n")}`;
}

/**
 * 流式释义。返回一个 async generator，逐块产出文本。
 *
 * 用法：
 *   for await (const chunk of streamExplain(params)) {
 *     // chunk 是一段文本
 *   }
 */
/**
 * 构建「讲解」这一轮的完整 messages（P33：供 handleExplain 缓存做卡复用）。
 * 与 streamExplain 内部用的逐字一致——做卡时前缀命中模型缓存的前提（spec §13 第 2 条）。
 */
export function explainTurns(params: ExplainParams): ChatTurn[] {
  const language = params.language ?? "en";
  const monolingual = params.monolingual ?? false;
  return [
    {
      role: "system",
      content: buildSystemPrompt(language, monolingual, params.word, {
        personalized: params.personalized === true,
        cardsEnabled: params.cardsEnabled !== false,
      }),
    },
    { role: "user", content: buildUserMessage(params) },
  ];
}

export async function* streamExplain(
  params: ExplainParams,
  ai?: AiConfig,
): AsyncGenerator<string, void, unknown> {
  const turns = explainTurns(params);

  yield* streamTurns(
    turns,
    {
      temperature: 0.3, // 释义要准确，不要发散
      // P32：偏好「讲细一点」的学生允许长一点，其余保持原来的 400
      maxTokens: params.detailed ? 600 : 400,
    },
    ai,
  );
}

/** 是否已配置可用的模型（小结接口据此决定「生成」还是「只提示去配置」） */
export function hasModelConfigured(ai?: AiConfig): boolean {
  return resolveProvider(ai?.settings ?? currentSettings(), ai?.env ?? process.env) !== null;
}

/**
 * 带重试的流式调用统一入口。
 * 网络抖动 / 限流 / 模型繁忙都重试；重开前先吐 STREAM_RESET，前端据此清屏，
 * 避免上一次的半成品和这一次拼在一起。
 */
async function* streamTurns(
  turns: ChatTurn[],
  opts: { temperature: number; maxTokens: number },
  ai?: AiConfig,
): AsyncGenerator<string, void, unknown> {
  const provider = resolveProvider(ai?.settings ?? currentSettings(), ai?.env ?? process.env);
  if (!provider) {
    yield NO_MODEL_NOTICE;
    return;
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const attempts = DEFAULT_RETRY.attempts;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) yield STREAM_RESET;
    try {
      for await (const chunk of streamChat(provider, turns, opts)) {
        yield chunk;
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1 || !isRetryableError(err)) throw err;
      await sleep(backoffDelayMs(attempt));
    }
  }
  throw lastError;
}

/**
 * 分段小结的 system prompt。
 *
 * 用户明确要求「这就是个 summary」：只概括这一部分讲了什么，不做论证分析、
 * 不逐句翻译、不分点罗列。给刚读完一段的读者做「我读懂了没」的确认。
 */
export function buildSummaryPrompt(): string {
  return `你是一位帮中文母语者读英文文章的阅读助教。用户正在读一篇文章，读到某一部分结束时想要一段简短总结，确认自己有没有读懂。
用户消息会给出这一部分的原文（连续若干自然段）。请用中文写一段总结，说明这一部分讲了什么。

要求：
- 2~3 句话，总长不超过 120 字
- 概括主要观点与关键信息，不逐句翻译，不堆细节
- 不分点、不加小标题、不写「总结：」之类的前缀，直接输出正文
- 不要评价文章写得好不好，也不要补原文没有的内容`;
}

/** 生成某一段落区间的小结（流式） */
export async function* streamSectionSummary(params: {
  /** 区间原文，段落之间用空行分隔 */
  body: string;
  paragraphCount: number;
}, ai?: AiConfig): AsyncGenerator<string, void, unknown> {
  const turns: ChatTurn[] = [
    { role: "system", content: buildSummaryPrompt() },
    {
      role: "user",
      content: `这一部分共 ${params.paragraphCount} 个自然段，原文如下：\n\n${params.body}`,
    },
  ];

  yield* streamTurns(
    turns,
    {
      temperature: 0.3,
      maxTokens: 400, // 120 字中文足够，留余量避免被截断
    },
    ai,
  );
}

/**
 * 非流式释义（用于不需要流式的场景，如缓存预取）
 */
export async function explain(params: ExplainParams): Promise<string> {
  let result = "";
  for await (const chunk of streamExplain(params)) {
    result += chunk;
  }
  return result;
}

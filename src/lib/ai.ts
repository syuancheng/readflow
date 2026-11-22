import { ASK_MAX_CHARS } from "./ask-presets";
import { planHistory } from "./history-compress";
import { assembleExplain } from "./prompt/layers";
import { MAX_REPLIES, REPLY_NOTE_MAX_CHARS, REPLY_TEXT_MAX_CHARS, type Reply } from "./ai-thread";
import type { SentenceWindow } from "./prompt/sentence-window";
import { resolveProvider, STREAM_RESET, type EnvMap, type SettingsMap } from "./config";
import { allSettings } from "./settings-store";
import { backoffDelayMs, DEFAULT_RETRY, isRetryableError } from "./retry";
import { streamChat, type ChatTurn, type ChatUsage } from "./providers";
import { NEAR_CONTEXT_MAX_SENTENCES, type ContextLayers, type SelectionSignals } from "./sentence";
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
 * 2026-11-16 P36：去掉 P14 的「同句二次扩面 / 三次整句」。同一句问了几次不再决定讲多深：
 *   默认只讲这句里的意思 + 一句为什么，要整句、要结构由学生点「问 AI」里的按钮；
 *   个性化开着时深度仍由学生档案判断。priorAsks 只用来避免重复。
 */

/** 当前生效的配置（服务端读本地 DB + 环境变量兜底） */
export function currentSettings(): SettingsMap {
  return allSettings();
}

/** 这次调用用谁的模型配置（P28：按账号区分，见 lib/user-secrets.ts）；不传 = 站级配置 */
export type AiConfig = { settings: SettingsMap; env: EnvMap };

/**
 * 同一条批注内、本轮之前已经完成的问答（2026-11-16 真正的多轮追问）。
 * - 默认讲解 ask 为空；追问 ask 是用户的问题标签/原文
 * - 只有文本、没有状态；进行中 / 报错的轮次由前端排除
 */
export type ExplainHistoryTurn = { ask?: string; text: string };

/**
 * 历史的「收包」上限：客户端一次最多送来多少轮、每轮多少字，防止请求体过大。
 * 真正发给模型的内容由 history-compress.ts 压缩（P45：首次讲解 + 最近 3 轮完整，中间压成要点）。
 */
export const EXPLAIN_HISTORY_MAX_TURNS = 30;
export const EXPLAIN_HISTORY_MAX_CHARS = 4000;
/** 学生这一次的提问最多多少字（前端输入框和服务端都限制） */
export const EXPLAIN_PROMPT_MAX_CHARS = ASK_MAX_CHARS;
/** 从 AI 回答里划选的引用片段上限（比提问稍宽，但仍防撑爆上下文） */
export const EXPLAIN_QUOTE_MAX_CHARS = 500;

/** 用户从 AI 回答里划选、要针对它提问的片段 */
export type ExplainQuote = { text: string; turnIndex: number };

export type ExplainParams = {
  word: string;          // 要解释的词或短语（选区）
  // 旧字段：只传给没升级到 contextLayers 的老调用方；新调用方一律用 contextLayers。
  // 两者都不传时 contextBlock 退回「用户选中 + context」的最简形式。
  context: string;       // 兜底上下文（旧调用只传一句话时使用）
  prefix?: string;       // 选区在段内的前文（可为空）
  suffix?: string;       // 选区在段内的后文（可为空）
  /**
   * 两层文章上下文（2026-11-19）：所在句 + 所在句之前 ≤150 词的近前文（倒序）。
   * 作为独立 system message 注入，内容只由段落原文与锚点决定，逐轮逐字稳定 → 缓存命中。
   */
  contextLayers?: ContextLayers;
  language?: string;     // 目标语言（正在学的语言），默认 en
  monolingual?: boolean; // true = 用目标语言解释，false = 用中文解释
  prompt?: string;       // 用户的自定义追问（对应 Readlang 的 askAI）
  /** 用户从 AI 回答里划选的引用片段；无引用时 user 消息逐字不变 */
  quote?: ExplainQuote;
  /** P58：多条回复（引用 + 批注）。有它时以它为准；只有旧的 quote 时等价于一条无批注的回复 */
  replies?: Reply[];
  withPrevSentence?: boolean; // 前文已包含上一句（「没看懂整句」信号触发），给模型加衔接提示
  /** 阅读器采集的客观信号（不是结论）。旧调用不带时模型仍可正常工作。 */
  signals?: SelectionSignals;
  /** P32：服务端合成的学生档案文本，插在 user 消息最前面；空串时不插入任何内容 */
  learnerBlock?: string;
  /** P34：前端显示的「你问：…」标题，只存进 explain_answers，不发给模型 */
  askLabel?: string;
  /** P34：选区锚点（批注还没保存好时，讲解结束后据此对上批注），不发给模型 */
  anchor?: { paragraphId: string; start: number; end: number };
  /** P32：个性化讲解开关。为假时系统提示词逐字保持旧规则 */
  personalized?: boolean;
  /** P32：偏好「讲细一点」。原来用来放宽 maxTokens；2026-11-15 起讲解不设上限，这个开关只作记录 */
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
  /**
   * P40：文章领域信息，由服务端按 textId 查库后注入，前端传值一律忽略。
   * 只有 askKind=domain 时才会带值；其他追问与默认讲解都为空，提示词逐字不变。
   */
  domainBlock?: string;
  /** 学生本人写下的硬性讲解要求，作为独立 system message 注入；不改上面的逐字快照 */
  teachingRules?: string;
  /**
   * 同一批注内本轮之前的对话（历史问答），由服务端白名单校验后传入。
   * 空/不传时 explainTurns 仍是原来的 [system, user] 两条，逐字不变。
   */
  history?: ExplainHistoryTurn[];
  /**
   * P57b：提示词结构。缺省 / "v1" = 原来的拼法（逐字不变）；"v2" = 分层结构（见 prompt/layers.ts）。
   * v2 只支持中文讲解（monolingual 为真时自动退回 v1）。
   */
  layout?: "v1" | "v2";
  /** v2 L3：句子窗口（前文 + 所在句 + 同段后一句），由服务端按 textId + anchor 算，客户端传值只作回退 */
  sentenceWindow?: SentenceWindow;
  /** v2 L1：学习档案里变动慢的部分（身份、阅读目的、备考、风格、老师笔记） */
  learnerStable?: string;
  /** v2 L5：学习档案里变动快的部分（水平、难点、反馈） */
  learnerVolatile?: string;
  /** v2 L2：标题与分类（任何 askKind 都带；v1 只在 domain 时带） */
  articleBlock?: string;
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
export const DEPTH_GUIDANCE_ZH = `【答案深度由你判断，不要问我】
根据「学生档案」和「观察」判断讲多深：L1 只给这句里的意思；L2 加上在这句里怎么理解或搭配；L3 再加「整句大意：」一句话概括；L4 再加句子地图，必要时给一个例句。拖选长片段、档案显示长句是难点时往深处走；档案显示水平高、偏好简洁、以往反馈「太深」偏多，都是判断的线索。「之前问过的选区」只用来避免重复讲同一内容，不决定讲多深。偏好简洁的学生最多加「整句大意：」，不主动画句子地图。学生档案里的「最近的反馈」是他对你最近几次讲解的评价（「太浅」「刚好」「太深」各一条）：「太浅」是讲完他还是没懂，「刚好」是他借着你的讲解自己读懂了，「太深」是你讲得太透、他没机会自己想。设这三档只为提醒你一件事——别每次都直接把答案、把句子意思告诉他，那样他会失去自己去理解的机会。这是评价的含义和设它的原因，不是操作清单：不要照着某次讲法复制或规避，怎么讲仍由你按这次的选区和档案判断；「最近的反馈」与「以往反馈」不一致时，以最近的为准。阅读目的会影响义项选择（例如技术文档读者优先给技术含义）。不论讲多深，第一行永远是「释义：」。
判断句法角色、两次选区是否重叠是老师的本职；不要输出判断过程，直接用答案体现。`;

/** monolingual 人设的等义英文指引（文档只给了中文段落，这里保持两套人设行为一致） */
const DEPTH_GUIDANCE_EN = `Depth is yours to judge from the observations and the "student profile":
L1 gives only the meaning in this sentence; L2 adds how to read or pair it here; L3 adds a one-sentence "整句大意：" whole-sentence meaning; L4 adds a sentence map and, if needed, one example. Go deeper when the student selected a long span, or the profile shows long sentences are a weak point. A high level, a preference for brevity, or mostly "太深" feedback in the profile are all signals to weigh. The "prior asks" are only for avoiding repetition, not for deciding depth. A student who prefers brevity gets at most the one-line whole-sentence meaning — never volunteer a sentence map unless they ask for structure. The "最近的反馈" (recent feedback) lines in the profile are the student's ratings of your last few answers, one per rating: 「太浅」 (too shallow) means he still didn't understand after your answer, 「刚好」 (just right) means he worked it out with your help, and 「太深」 (too deep) means you laid everything out so he had no chance to think. These three levels exist only to remind you of one thing — do not hand him the answer or the sentence's meaning every time, or he loses the chance to understand it himself. These are the meanings of the ratings and why they exist, not an instruction list: do not copy or avoid any particular past answer; how to answer is still yours to judge from this selection and the profile. When recent feedback disagrees with the long-term 「以往反馈」 statistic, follow the recent feedback. The reading goal affects which sense you choose (a technical reader gets the technical meaning of "artifact"). Keep the prose short and answer exactly the selection. Do not output your reasoning.`;

function personalizeDepth(prompt: string, monolingual: boolean): string {
  const start = monolingual
    ? "Depth (default) — judge from the selection itself every time, and stop there:"
    : "【答案深度】";
  const end = monolingual ? "Never: phonetic symbols" : "【硬性禁止】";
  const i = prompt.indexOf(start);
  const j = i < 0 ? -1 : prompt.indexOf(end, i);
  if (i < 0 || j < 0) return prompt; // 找不到就原样返回，绝不破坏旧行为
  const guidance = monolingual ? DEPTH_GUIDANCE_EN : DEPTH_GUIDANCE_ZH;
  return prompt.slice(0, i) + guidance + "\n\n" + prompt.slice(j);
}

/**
 * P33（spec §7.1）：制卡建议规则，追加在系统提示词末尾。
 * 个性化开关打开和关闭时都追加（PRD 规定两者互不依赖）——「P32 快照逐字不变」
 * 指的是讲解深度那部分，制卡建议是 P33 新增的，快照测试同步更新（用户已确认）。
 */
export const CARD_SUGGESTION_ZH = `【制卡建议（可选，只在最后一行）】
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

/**
 * P40：领域专家人设（「从内容角度讲讲这句」专用）。
 *
 * 与英语老师彻底分开：默认讲解的 system prompt 有逐字快照测试，这里一行都不碰。
 * 只在 askKind=domain 时由 explainTurns 选用；学生已经看过翻译和句法，这一轮
 * 回答的是「这句话在它的专业领域里到底在说什么、为什么这么说」。
 */
export function buildDomainSystemPrompt(): string {
  return `你是一位资深的专业技术人员，不是英语老师。学生已经知道这句话的中文意思和句子结构，现在他问的是：「这句话在我的专业领域里，到底在说什么？」

【你收到的信息】
用户消息最前面是「这篇文章」——标题与用户设定的分类（可能只有其中一项，也可能都没有）；接着是「用户选中」——那是一整个句子，也就是你要讲的对象。

【第一步：判断领域，但不要花篇幅论证判断】
用标题、分类和这句话的内容判断这篇文章属于哪个专业领域——法律、AI 工程、医学、金融、材料、历史，等等。
- 标题或分类给了线索：直接用它，按那个领域的行话讲。分类很宽泛（例如「技术文档」）时，再从这句话的内容收窄到具体方向。
- 都没有线索：从这句话里的术语推断；推断不出来就说明「仅凭这句话难以确定具体领域」，然后就这句话本身能确定的内容讲，不要装作某个领域的专家。
- 不要输出「本文属于 X 领域」这类判断过程，直接按该领域的理解作答。

【第二步：用这个领域的语言把这句话讲透】
学生缺的不是中文，是作者默认读者已经懂的领域背景。按需要的顺序讲：
- 这句话涉及什么专业概念、现象或设计取舍；它在这一行里通常指什么；
- 作者为什么这么写、这么划分或这么设计——背后的约束、惯例或权衡是什么；
- 这个词／说法在这个领域里的含义和日常英语里的差别（如果有的话）；
- 它在这篇文章的论证里起什么作用，只讲能从上下文推断出来的，不要脑补作者没写的立场。

【领域知识的可信边界——最重要】
- 不确定的具体内容直接标注「（存疑）」或「这里不确定」，不要编造法条编号、条款名称、论文标题、数值、产品型号、API 名称、公司案例。
- 领域判断有把握时按该领域的通行理解讲；只有中等把握时说「通常来说」「在这类场景下」，给典型情况而不是唯一答案。
- 宁可少讲一个点，也不要给一个听起来专业但可能是错的事实。

【硬性边界】
- 不逐字翻译，不解释时态、介词、从句，不画句子地图——那些是英语老师刚才已经讲过的，重复就是浪费。
- 不写「释义：」行：那一行会显示在正文词的上方，是英语老师专用的。
- 中文说明控制在 250 字以内；一次只讲一两个最要紧的点，讲透比讲全重要。
- 不使用 Markdown 标题、编号列表、表格、代码块、HTML；不寒暄、不写「希望有帮助」。
- 用中文作答；专业术语、缩写、原文引用保留英文。`;
}

/**
 * P44：「讲讲句子结构」这一轮专用的拆句方法（只作为独立 system message 注入）。
 *
 * 参考 B 站 UP 主李文庆长难句四规则，按学生画像做了三处取舍：
 * - 「跳过插入成分」改成「先挪一边，抓完主干再回来看」——他是 A2，把限定当废话会读反；
 * - 「虚拟倒装」只留「Were/Had/Should 开头先还原成 if」一句识别提示，不展开语法；
 * - 补上「先找谓语动词」这个锚点——比找 that/wh- 更稳，且他没有这个习惯。
 *
 * 「生词美语：积累」不进这一轮讲解，走词库与长期记忆，见后续改动。
 *
 * 关键：不碰 legacySystemPrompt 的逐字快照，也不改输出格式（句子地图仍由人设管）。
 * 只教「怎么拆」，让学生保留自己分析的机会——这是他明确写下的硬要求。
 */
export function buildSentenceStructureMethodPrompt(): string {
  return `【这一轮：带学生拆开这个长句】
学生点「讲讲句子结构」，要学的不是一个答案，是一套自己能重复用的拆解动作。你在心里按下面的顺序拆，最后用你本来的句子地图格式呈现；不要把这些步骤写成编号说明念给他。

先定锚：先找谓语动词，不要先找中文意思。一句里有几个谓语，就有几个从句或并列分句；先定主句那个谓语，它的主语和宾语／表语就是主干。谓语比 that / wh- 更可靠。

再切两处干扰：
- 从句与分句：在标点和信号词（that / wh- / because / although 等）处切开，先看主句。
- 插入成分：逗号、括号、破折号隔开的补充说明先挪到一边，抓完主干再回来看它补了什么、限定的是谁。不要直接扔掉——他水平还不高，把关键限定当废话跳过去会读反。

最后复原变形：Were / Had / Should 开头的条件句，先在心里还原成 if 从句再读；只点一句「这里是倒装，还原后是……」就够，不要展开虚拟语气语法。

一次只带他走最卡的一两处，拆完把主干标到句子地图上。给的是标注和判断的抓手，不是整句逐字翻译——他要保留自己分析句型结构的机会。`;
}

/** 两层上下文里单条文本的字数上限（只在服务端白名单校验时用） */
export const CONTEXT_LAYER_SENTENCE_MAX_CHARS = 4000;
export const CONTEXT_LAYER_NEAR_MAX_CHARS = 2000;

/**
 * 上下文两层白名单：客户端传来的 contextLayers 只取 { sentence, nearContext }，
 * 逐条裁剪字数、限制条数；非法结构整条丢弃，额外字段不透传。
 * 与 narrowHistory / narrowQuote 同款规则，服务端与单测共用。
 */
export function narrowContextLayers(v: unknown): ContextLayers | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.sentence !== "string") return undefined;
  const sentence = o.sentence.trim().slice(0, CONTEXT_LAYER_SENTENCE_MAX_CHARS);
  if (!sentence) return undefined;
  const nearContext: string[] = [];
  if (Array.isArray(o.nearContext)) {
    for (const item of o.nearContext.slice(0, NEAR_CONTEXT_MAX_SENTENCES)) {
      if (typeof item !== "string") continue;
      const text = item.trim().slice(0, CONTEXT_LAYER_NEAR_MAX_CHARS);
      if (text) nearContext.push(text);
    }
  }
  return { sentence, nearContext };
}

/**
 * 把两层上下文做成独立 system message（2026-11-19）。
 *
 * 位置：rules 之后、history 之前——夹在「稳定的规则」和「逐轮变化的历史」之间，
 * 同一条批注的每一轮，人设 + 规则 + 两层上下文逐字相同，前缀缓存稳定命中。
 *
 * 内容只来自 contextLayers（段落原文 + 锚点算出的结果），不读任何会变化的状态。
 * 分层说明直接写进提示词：所在句是讲的对象，近前文只是背景，别混、别翻译。
 */
export function buildContextLayersSystemMessage(layers: ContextLayers): string {
  const near = layers.nearContext.length
    ? layers.nearContext.map((s, i) => `${i + 1}. "${s}"`).join("\n")
    : "（文章开头，没有更早的原文）";
  return `【文章上下文：两处不同，别混用】
- 「所在句」是学生选中的词／短语直接所在的那句，是你要讲的对象：词义、搭配、句法都以它为准。
- 「近前文」是所在句之前最多 150 词的原文，按倒序（离所在句最近的排最前），只用来理解 that / it / the one 这类指代、承接与省略。它是背景，不是学生选中的内容——不要把它逐字译成中文，也不要把它当成学生的问题。

近前文（背景，倒序）：
${near}

所在句（讲的对象）：
"${layers.sentence}"`;
}

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
export function legacySystemPrompt(language: string, monolingual: boolean): string {
  if (monolingual) {
    return `You are a native ${language} teacher who also understands Chinese. Your student is a Chinese native speaker reading a real ${language} text and has selected a piece of it to ask about. Knowing Chinese means you can anticipate where Chinese speakers misread ${language}: tense, articles, prepositions, polysemy, clause structures Chinese lacks, tone and register.

Your only job: explain what the selected text means in the sentence it appears in, so the student can keep reading.

Core rule — answer exactly the selection:
1) The first paragraph is the main body. Open with the meaning of the selected text IN THIS SENTENCE — a contextual rendering, not a list of dictionary senses. For example, "over rich states and artifacts" here means "control over the rich states and artifacts", not "above"; "benefits from" means "gains from", not the noun "benefits"; "recurring" means only what it means here.
   · Exception: when the Depth judgment below calls for it, open with a whole-sentence meaning first.
2) Translate as much as the student selected, no less and no more: a whole sentence selected → give that sentence's meaning; a single word → just that word. Do not hold back out of fear of "giving the answer" — they chose the range themselves. But never translate the surrounding English that was NOT selected.
   · Exception: when the Depth judgment below calls for it, you may open with whole-sentence meaning — but label it "整句大意：" (whole-sentence meaning) and make it a one- to two-sentence PARAPHRASE of what the sentence is about, NOT a word-for-word translation of the unselected English.
   Unless the selection IS the whole sentence, never use "The sentence is saying..." / "In other words..." / "Here it says..." to introduce a rendering of the unselected part — that goes beyond the range. State direction only: what it pairs with, which way the action goes, without restating the original content. Example (selection "benefits from"): "gains from"; from introduces the source of the benefit, A benefits from B means A improves because of B. When writing whole-sentence meaning, use the "整句大意：" label above — do not use the banned "The sentence is saying..." phrasing.
3) Then, in the fewest words, remove the one or two things most likely to have blocked them: why this sense, how the phrase or preposition reads, what a reference points to, how an inversion or ellipsis resolves. Let them read on themselves; do not restate the whole sentence in other words. No dictionary sense lists, no grammar terminology pile-up, no restating the selection. When the same sentence was asked before, do not repeat what a prior ask already covered.
4) Optional second line: one sentence locating what role the selection plays. Light answers may omit it.

Last, and only when needed: a "sentence map" in 2–3 symbolic lines. Lead with an emoji + pattern label (for example 🧩 SVC · predicative with a relative clause), then the original sentence with ONLY the backbone wrapped in ==role: text== so the role renders as a small label right under the underlined backbone — leave every other constituent untouched, do not label them one by one with brackets. Use Chinese role labels: 主语 subject / 谓语 verb / 宾语 object / 表语 predicative / 状语 adverbial. Example: ==主语：A recurring pattern== ==谓语：is== ==表语：simple control== over rich states and artifacts. Then optionally one ⚠️ pitfall or 🔗 reference line. For long sentences elide the rest with … and say what was elided. Unsure constituents get "(uncertain)" — never guess. If the structure is unclear, omit the map entirely. Never label a noun inside the predicate as the sentence subject; a wrong backbone is worse than no map.

Depth (default) — judge from the selection itself every time, and stop there:
- A peripheral modifier → light (meaning + one line of why, no map).
- A backbone constituent, passive, inversion or clause → meaning + why + the map.
Do not volunteer a "整句大意：" whole-sentence meaning; the student has buttons for "整句没看懂" (whole sentence) and "讲讲句子结构" (structure) and will press them when needed.
How many times this sentence was asked about never decides depth. The "prior asks" are only for avoiding repetition.
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
- 即使要先写「整句大意：」，第一行也仍然是「释义：」这一行，「整句大意：」放在它下面。

【核心规则：只答选中的那一段】
- 「用户选中」就是学生这次要问的范围。第一屏（「释义：」那一行之后）先把「选中部分在这句话里的中文意思」讲透——按这句的语境译，不是搬词典义项。例如选中 over rich states and artifacts，给「对丰富的状态与产物（的控制）」而不是「在…之上」；选中 benefits from，给「受益于」而不是「好处」；选中 recurring，只给这句里「反复出现的」这一个意思。
  · 例外：按下方「答案深度」判断需要整句大意时，第一屏先给整句大意再给选区意思。
- 选区多大就译多大：选区是一整个句子，就把这一句译出来；是一个词，就只给这个词。不要因为怕「直接给答案」而克制、改给半句或只给主干概括——范围由学生自己划定，这正是他要的。
- 但不要把选区以外、前后文里没被选中的英文也顺手译成中文。译的是选区，不是整段。
  · 例外：按下方「答案深度」判断需要整句大意时，可以给整句大意——但必须用「整句大意：」这个标记开头，且是**概括一句话**（约一两句中文讲清这句在讲什么），不是逐字对译选区外的英文。
- 选区不是整句时，不要用「整句在说：」「整句说的是：」「这里说的是：」「整句在讲」这类句式把没选中的英文逐字译成中文——那等于把没选中的英文也译了，是越界。要讲方向，只说它跟谁搭配、动作朝哪个方向，不复述原句内容。
  正例（选区 benefits from）：「受益于」。from 引出好处的来源，A benefits from B 是「A 因 B 变好」，别读反；benefits 在这里是动词，不是名词「好处」。
  · 要写整句大意时，用上面说的「整句大意：」标记，不要套用「整句在说：」等禁用句式——它们一个是授权概括，一个是越界逐字译，别混。
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

【答案深度】
每次都按选区本身判断，讲到这一层就停：
- 选区是边缘成分 → 轻答：意思 + 一句为什么，1~2 句，**句子地图不写**。
- 选区是主干成分，或涉及被动语态、倒装、从句 → 中答：意思 + 为什么 + 句子地图。
不主动写「整句大意：」：学生需要整句时，会自己点「整句没看懂」或「讲讲句子结构」。
这句被问过几次不决定讲多深；「之前问过的选区」只用来避免重复讲同一内容。
判断句法角色是老师的本职；不要输出判断过程，直接用答案体现。

【硬性禁止】
- 不输出音标、寒暄、「希望有帮助」；不使用旧版那种固定三节小标题，不写编号列表。
- 第一段不堆语法术语、不写成语法讲义；不把语法分析放到第一段。
- 选区不是整句时，不写「整句在说：」「整句说的是：」「这里说的是：」这类把没选中的英文逐字复述成中文的句子；这是越界，不是释义。要写整句大意，用「整句大意：」标记，不要用这里的禁用句式。
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
/** 学生通过输入框自由提问（askKind = custom）时的尾部聚焦提示：唤醒直接作答、解除默认词义模板 */
export const CUSTOM_ASK_TAIL_HINT =
  "（请直接、正面回答「学生的问题」：如果他在核对自己的理解或猜测，第一句话先明确回应他的理解对不对、哪处有偏差，再展开解释；不要套用默认的选区词义讲解模板，不要写「释义：」行，也不受「只答选区、不译选区外」的限制。）";

function formatStudentQuestion(params: Pick<ExplainParams, "prompt" | "askKind">): string {
  if (!params.prompt) {
    return "学生没有说出具体问题。请根据选区、所在句子和观察，判断他卡在哪里，然后直接回答。";
  }
  const line = `学生的问题: ${params.prompt}`;
  return params.askKind === "custom" ? `${line}\n${CUSTOM_ASK_TAIL_HINT}` : line;
}

/** 导出供单测做控制变量断言 */
export function buildUserMessage(params: ExplainParams): string {
  const question = formatStudentQuestion(params);
  // P32：学生档案放在最前面；为空时不插入任何字符，旧调用的输出逐字不变
  const learner = params.learnerBlock?.trim() ? `${params.learnerBlock.trim()}\n\n` : "";
  // P40：领域块只由服务端按 textId 查库后注入；前端伪造的字段会在 handler 里被丢弃。
  // 没有值时一个字符都不插入，其他追问与默认讲解的 user message 逐字不变。
  const domain = params.domainBlock?.trim() ? `这篇文章：\n${params.domainBlock.trim()}\n\n` : "";
  // 用户在回答里划选的片段：明确告诉他这是模型自己上一轮说的原话，
  // 让模型把它当作「在澄清自己的表述」而不是一条新证据。无引用时不插入任何字符。
  const quoteSec = repliesSection(params);
  const quote = quoteSec ? `\n${quoteSec}` : "";
  return `${domain}${learner}${contextBlock(params)}${quote}
${question}`;
}

/** 组装上下文块：新调用方（contextLayers）的上下文已移到 system，这里只剩用户选中；老调用方逐字不变 */
function contextBlock(params: ExplainParams): string {
  const { word, context, prefix, suffix, withPrevSentence } = params;
  let base: string;
  if (params.contextLayers) {
    // 两层上下文在 buildContextLayersSystemMessage 里；user 消息只保留「选中了什么」。
    base = `用户选中: "${word}"`;
  } else if (typeof prefix === "string" || typeof suffix === "string") {
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
  // 两层上下文启用后，所在句已进 system 的 layer1，user 消息不再重复一遍
  const sentence = params.contextLayers ? "" : signals.sentence.trim();
  if (sentence) lines.push(`- 所在句子原文: "${sentence}"`);
  if (typeof signals.dictHit === "boolean") {
    lines.push(`- 词典: ${signals.dictHit ? "已收录" : "未收录"}`);
  }
  // P36：「同句第几次」不再决定要不要问 AI、讲多深，不交给模型；之前问过的选区只用来避免重复
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
/**
 * 历史白名单：客户端传来的 history 只取 {ask?, text}，
 * 逐条裁剪字数、限制条数；非法结构整条丢弃，额外字段不透传。
 * 放在纯函数模块里，服务端与单测共用同一份规则。
 */
export function narrowHistory(v: unknown): ExplainHistoryTurn[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: ExplainHistoryTurn[] = [];
  for (const item of v.slice(-EXPLAIN_HISTORY_MAX_TURNS)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.text !== "string") continue;
    const text = o.text.trim().slice(0, EXPLAIN_HISTORY_MAX_CHARS);
    if (!text) continue;
    const ask = typeof o.ask === "string" ? o.ask.trim().slice(0, 60) : undefined;
    out.push({ ...(ask ? { ask } : {}), text });
  }
  return out.length > 0 ? out : undefined;
}

/** 这次提问实际带的回复：replies 优先；只有旧的 quote 时当作一条无批注的回复 */
export function effectiveReplies(params: Pick<ExplainParams, "replies" | "quote">): Reply[] {
  if (params.replies?.length) return params.replies;
  const t = params.quote?.text?.trim();
  return t ? [{ text: t }] : [];
}

/**
 * 提示词里的「引用 / 批注」段（P58）。
 * 只有 1 条且没有批注时，与改前逐字相同（保证旧快照与旧行为不变）；其余按序号逐条列出。
 * 没有回复时返回空串。
 */
export function repliesSection(params: Pick<ExplainParams, "replies" | "quote">): string {
  const rs = effectiveReplies(params).slice(0, MAX_REPLIES);
  if (rs.length === 0) return "";
  const q = (r: Reply) => `「${r.text.trim().slice(0, REPLY_TEXT_MAX_CHARS)}」`;
  if (rs.length === 1 && !rs[0].note?.trim()) return `你引用了自己上一条回答里的这段话：\n${q(rs[0])}`;
  const items = rs.map((r, i) => {
    const note = r.note?.trim() ? `\n   学生的批注：${r.note.trim().slice(0, REPLY_NOTE_MAX_CHARS)}` : "";
    return `${i + 1}. ${q(r)}${note}`;
  });
  return `你引用了自己前面回答里的几处话，并写了批注（按顺序）：\n${items.join("\n")}`;
}

/** 回复白名单（P58）：只取 text（≤500）与 note（≤200），最多 5 条，空文本整条丢弃；非法结构丢弃 */
export function narrowReplies(v: unknown): Reply[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Reply[] = [];
  for (const item of v) {
    if (out.length >= MAX_REPLIES) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.text !== "string") continue;
    const text = o.text.trim().slice(0, REPLY_TEXT_MAX_CHARS);
    if (!text) continue;
    const note = typeof o.note === "string" ? o.note.trim().slice(0, REPLY_NOTE_MAX_CHARS) : "";
    out.push({ text, ...(note ? { note } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

/** 引用片段白名单：只取 text（裁剪字数）与 turnIndex（非负整数），非法输入丢弃 */
export function narrowQuote(v: unknown): ExplainQuote | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== "string") return undefined;
  const text = o.text.trim().slice(0, EXPLAIN_QUOTE_MAX_CHARS);
  if (!text) return undefined;
  const raw = typeof o.turnIndex === "number" && Number.isInteger(o.turnIndex) && o.turnIndex >= 0
    ? o.turnIndex
    : 0;
  return { text, turnIndex: Math.min(raw, 99) };
}

/**
 * 把历史问答展开成多轮 messages：一轮 = 一条 user（学生当时的问题）+ 一条 assistant（老师当时的回答）。
 *
 * 默认讲解那轮 ask 为空，用一句固定措辞还原当时「学生没有说出具体问题」的情形，
 * 与 buildUserMessage 在无 prompt 时的收尾一致，避免凭空编一个问题。
 * 先过 planHistory 压缩（P45）：首次讲解和最近 3 轮完整，中间压成要点；轮数不多时内容与原来逐字一致。
 * 有整轮被丢掉时，开头加一句说明，让模型知道前面有省略。空文本轮次丢弃。
 */
export function historyTurns(
  history: readonly ExplainHistoryTurn[] | undefined,
  opts?: { blockSize?: number },
): ChatTurn[] {
  if (!history || history.length === 0) return [];
  const eligible = history.filter((t) => t.text?.trim());
  if (eligible.length === 0) return [];
  const plan = planHistory(
    eligible.map((t) => ({ ...(t.ask ? { ask: t.ask } : {}), text: t.text.trim() })),
    undefined,
    opts?.blockSize ? { blockSize: opts.blockSize } : undefined,
  );
  const out: ChatTurn[] = [];
  if (plan.omitted > 0) {
    out.push({ role: "system", content: `（这处批注上更早的 ${plan.omitted} 轮对话已省略，下面只保留了要点和最近的几轮。）` });
  }
  for (const t of plan.turns) {
    const asked = t.ask?.trim();
    out.push({ role: "user", content: asked ? `学生的问题: ${asked}` : "学生没有说出具体问题，请我判断他卡在哪里。" });
    out.push({ role: "assistant", content: t.text });
  }
  return out;
}

/**
 * v2 的最后一条 user 消息（L5）：变体指令 → 易变档案 → 所在句 → 选区 → 观察 → 引用 → 问题。
 * 顺序固定、缺项整行省略；问题放最后。
 */
export function buildUserTail(params: ExplainParams, variantBlock: string): string {
  const question = formatStudentQuestion(params);
  const sentence = (params.sentenceWindow?.sentence || params.contextLayers?.sentence || params.signals?.sentence || "").trim();
  const quote = repliesSection(params);
  // observations() 在有 contextLayers 时不重复所在句；v2 所在句单独成行，所以这里同样跳过
  const obs = observations({ ...params, contextLayers: params.contextLayers ?? { sentence, nearContext: [] } });
  return [
    variantBlock.trim(),
    params.learnerVolatile?.trim() ?? "",
    sentence ? `所在句: "${sentence}"` : "",
    `用户选中: "${params.word}"`,
    obs,
    quote,
    question,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function explainTurns(params: ExplainParams): ChatTurn[] {
  if (params.layout === "v2" && params.monolingual !== true) return assembleExplain(params);
  const language = params.language ?? "en";
  const monolingual = params.monolingual ?? false;
  // P40：只有「从内容角度讲讲」这一轮换人设；其他所有 askKind 仍走逐字不变的英语老师。
  const system =
    params.askKind === "domain"
      ? buildDomainSystemPrompt()
      : buildSystemPrompt(language, monolingual, params.word, {
          personalized: params.personalized === true,
          cardsEnabled: params.cardsEnabled !== false,
        });
  // 学生明确要求放在人设之后、历史之前：既优先于一般偏好，又不碰 legacySystemPrompt 的逐字快照。
  const rules = params.teachingRules?.trim();
  // P44：「讲讲句子结构」这一轮追加拆句方法；放在学生规则之前，硬规则仍然优先。
  // 其他 askKind 与默认讲解一个字符都不变。
  const structureMethod = params.askKind === "structure" ? buildSentenceStructureMethodPrompt() : "";
  // 两层上下文：文章事实，逐轮逐字稳定，放 history 之前才能命中前缀缓存
  const layers = params.contextLayers ? buildContextLayersSystemMessage(params.contextLayers) : "";
  // 历史在前、本轮 user 在最后；无历史、无规则、非 structure 时就是你看到的原有两条，逐字不变。
  return [
    { role: "system", content: system },
    ...(structureMethod ? [{ role: "system" as const, content: structureMethod }] : []),
    ...(rules ? [{ role: "system" as const, content: rules }] : []),
    ...(layers ? [{ role: "system" as const, content: layers }] : []),
    ...historyTurns(params.history),
    { role: "user", content: buildUserMessage(params) },
  ];
}

export async function* streamExplain(
  params: ExplainParams,
  ai?: AiConfig,
  signal?: AbortSignal,
  /** P57a：流结束时回传用量（输入/输出/缓存命中 token） */
  onUsage?: (usage: ChatUsage) => void,
): AsyncGenerator<string, void, unknown> {
  const turns = explainTurns(params);

  yield* streamTurns(
    turns,
    {
      temperature: 0.3, // 释义要准确，不要发散
      // 讲解不设输出上限（用户 2026-11-15 决定）：回答多长就完整显示，长度只由提示词控制。
      // 原来的 400 / 600 会让模型写到一半被迫停笔，页面停在半句话。
      maxTokens: null,
      signal,
      onUsage,
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
  opts: { temperature: number; maxTokens: number | null; signal?: AbortSignal; onUsage?: (usage: ChatUsage) => void },
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
}, ai?: AiConfig, signal?: AbortSignal): AsyncGenerator<string, void, unknown> {
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
      signal,
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

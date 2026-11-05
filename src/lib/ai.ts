import { resolveProvider, STREAM_RESET, type SettingsMap } from "./config";
import { allSettings } from "./settings-store";
import { backoffDelayMs, DEFAULT_RETRY, isRetryableError } from "./retry";
import { streamChat, type ChatTurn } from "./providers";
import { selectionKind } from "./sentence";

/**
 * AI 释义：模型与 Key 由「配置中心」决定（设置页可配 DeepSeek / OpenAI /
 * Claude / 千问 / 任意 OpenAI 兼容端点，勾选哪个用哪个）。
 *
 * 对齐 Readlang 的 Explain 设计：
 * - 带段落级上下文（选区 + 前文 + 后文分开标注），而不是只有一句话
 * - 流式输出（SSE），逐块返回
 * - 三套分层模板（单词 / 短语 / 句子）：
 *   词与短语「通常意思 → 在这里的意思 → 其他用法」；
 *   句子「翻译 → 结合语境的解释 → 主谓宾分析（必填，备考雅思/托福长难句训练）」
 * - 支持 askAI：用户自由追问
 * - 网络错误 / 限流 / 模型繁忙统一重试，重试用 STREAM_RESET 通知前端清屏
 */

/** 当前生效的配置（服务端读本地 DB + 环境变量兜底） */
export function currentSettings(): SettingsMap {
  return allSettings();
}

export type ExplainParams = {
  word: string;          // 要解释的词或短语（选区）
  context: string;       // 兜底上下文（旧调用只传一句话时使用）
  prefix?: string;       // 选区在段内的前文（可为空）
  suffix?: string;       // 选区在段内的后文（可为空）
  language?: string;     // 目标语言（正在学的语言），默认 en
  monolingual?: boolean; // true = 用目标语言解释，false = 用中文解释
  prompt?: string;       // 用户的自定义追问（对应 Readlang 的 askAI）
  withPrevSentence?: boolean; // 前文已包含上一句（「没看懂整句」信号触发），给模型加衔接提示
};

/**
 * 构建 system prompt（中文解释模式）
 *
 * 三套分层模板，顺序由用户指定（2026-11-05）：
 * - 单词/短语：通常意思 → 在这句话/上下文中的意思 → 其他含义或用法
 * - 句子：翻译 → 结合语境的解释 → 主谓宾分析（必须放最后、不可省略——
 *   用户备考雅思/托福阅读，找主语、谓语动词是核心训练）
 * 不输出音标（词典卡已有）。
 */
/** 导出供单测断言输出结构（不对外承诺稳定性） */
export function buildSystemPrompt(language: string, monolingual: boolean, word: string): string {
  if (monolingual) {
    return `You are a language teacher helping a student learn ${language}. The student selects a word or phrase while reading; the user message marks the selection and its surrounding paragraph (before/after).
Explain the SELECTED text IN ${language.toUpperCase()} using simple, clear language.
- For a word or phrase: lead with its usual meaning, then what it means in this sentence/context, then any other common meanings or usages.
- If it's a sentence-like selection: give a natural translation first, then explain it in context, and ALWAYS finish with a subject–verb–object analysis of the sentence (identify the subject, the main verb, and the object/complement; point out clauses or structures that affect understanding). This section is mandatory and must come last — the student is training long-sentence parsing for IELTS/TOEFL reading.
- You may quote the surrounding text to interpret meaning, but never explain other words from it.
Be concise but thorough.`;
  }

  const kind = selectionKind(word);

  if (kind === "sentence") {
    return `你是一位帮中文母语者读英文文章的阅读助教。用户在读文章时划选了一个句子——用户在备考雅思/托福阅读，看懂意思之外，长难句结构分析（找主语、谓语动词）是核心训练。
用户消息会标注「用户选中」的文本，以及它在段落中的「前文」「后文」。请严格按以下格式用中文输出（Markdown）：

**翻译**
第一行就给结合语境的通顺中文翻译。先在心里圈出选区所在的完整句子，翻译必须覆盖该句的全部成分——主语、并列项一个都不能丢；选区只划到半句时，把后半句的意思补进来一起译。

**结合语境的解释**
联系前后文解读这句话：指代、逻辑关系、语气与言外之意。与翻译重复的内容不要再说一遍。

**主谓宾分析**
（此节为固定最后一节，任何情况下都不可省略。）用几行标出句子主干与关键结构：
- 主语：…（有较长修饰语时注明核心词）
- 谓语动词：…（时态、语态有要点就顺带一句）
- 宾语/表语：…（无则写「无」）
- 最后一句话点出从句、插入语、倒装、并列等影响理解的结构。
分析必须准确，没有把握的成分宁可标注「（存疑）」也不要编造。

硬性要求：
- 使用粗体小标题分行，不要使用「1. 2. 3.」这类编号
- 「主谓宾分析」永远放最后，且绝不能省略——只给翻译或只给语境解释都算不合格
- 解释对象永远是「用户选中」的部分；鼓励引用前后文来解读整句含义，但不要去解释前后文里的其他词
- 不要输出音标
- 总长控制在 300 字以内`;
  }

  // 单词 / 短语：同一套「通常 → 在这里 → 其他」结构，仅措辞不同
  const noun = kind === "word" ? "这个词" : "这个短语";
  return `你是一位帮中文母语者读英文文章的阅读助教。用户在读文章时${kind === "word" ? "点选了一个词" : "划选了一个短语"}，想快速看懂文章、顺带学${noun}。
用户消息会标注「用户选中」的文本，以及它在段落中的「前文」「后文」。请严格按以下格式用中文输出（Markdown）：

**通常意思**
${noun}${kind === "word" ? "最常见的含义，可顺带词性（如 *v. 使欣喜*）" : "最常见的整体含义"}。一到两句话。

**在这里的意思**
结合上下文，${noun}在这句话里的具体意思；与通常意思一致时，直接说明并用半句话点出它在句中的作用。语气、语体的提示（如「比『高兴』更强烈」）也放这里。

**其他用法**
除上述之外，${noun}常见的其他含义、固定搭配或用法；确实没有就写「无」。

硬性要求：
- 使用粗体小标题分行，不要使用「1. 2. 3.」这类编号
- 解释对象永远是「用户选中」的部分；可引用前后文帮助解读，但不要去解释前后文里的其他词
- 不要输出音标——词典卡已提供
- 简洁，总长不超过 150 字`;
}

/**
 * 构建 user message
 * 有 prefix/suffix 时按「选中/前文/后文」分段标注；否则退回旧的整句 context。
 */
function buildUserMessage(params: ExplainParams): string {
  const { word, context, prefix, suffix, prompt } = params;

  if (prompt) {
    // askAI 模式：用户自由提问（同样带上段落上下文）
    return `${contextBlock(params)}
Question: ${prompt}`;
  }

  return `${contextBlock(params)}
请按 system 要求的结构解释「用户选中」的部分。`;
}

/** 组装「选中/前文/后文」的分段上下文块 */
function contextBlock(params: ExplainParams): string {
  const { word, context, prefix, suffix, withPrevSentence } = params;
  if (typeof prefix === "string" || typeof suffix === "string") {
    const pre = (prefix ?? "").trim();
    const suf = (suffix ?? "").trim();
    const hint = withPrevSentence
      ? "\n（提示：前文开头是选区所在句的上一句，可用于理解指代、承接等句间衔接。）"
      : "";
    return `用户选中: "${word}"
前文: ${pre ? `"${pre}"` : "（无）"}
后文: ${suf ? `"${suf}"` : "（无）"}${hint}`;
  }
  return `用户选中: "${word}"
所在句子: "${context}"`;
}

/**
 * 流式释义。返回一个 async generator，逐块产出文本。
 *
 * 用法：
 *   for await (const chunk of streamExplain(params)) {
 *     // chunk 是一段文本
 *   }
 */
export async function* streamExplain(
  params: ExplainParams
): AsyncGenerator<string, void, unknown> {
  const language = params.language ?? "en";
  const monolingual = params.monolingual ?? false;
  const turns: ChatTurn[] = [
    { role: "system", content: buildSystemPrompt(language, monolingual, params.word) },
    { role: "user", content: buildUserMessage(params) },
  ];

  yield* streamTurns(turns, {
    temperature: 0.3, // 释义要准确，不要发散
    maxTokens: 1200,  // 分层模板在句子场景下需要更长输出
  });
}

/** 没配置模型时的统一提示（释义与小结共用） */
export const NO_MODEL_NOTICE =
  "⚠️ 还没有配置 AI 模型。\n\n点击右上角头像 → **设置** → 勾选一个模型并填入 API Key；也可以继续用环境变量 `DEEPSEEK_API_KEY` 等作为兜底。";

/** 是否已配置可用的模型（小结接口据此决定「生成」还是「只提示去配置」） */
export function hasModelConfigured(): boolean {
  return resolveProvider(currentSettings(), process.env) !== null;
}

/**
 * 带重试的流式调用统一入口。
 * 网络抖动 / 限流 / 模型繁忙都重试；重开前先吐 STREAM_RESET，前端据此清屏，
 * 避免上一次的半成品和这一次拼在一起。
 */
async function* streamTurns(
  turns: ChatTurn[],
  opts: { temperature: number; maxTokens: number },
): AsyncGenerator<string, void, unknown> {
  const provider = resolveProvider(currentSettings(), process.env);
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
}): AsyncGenerator<string, void, unknown> {
  const turns: ChatTurn[] = [
    { role: "system", content: buildSummaryPrompt() },
    {
      role: "user",
      content: `这一部分共 ${params.paragraphCount} 个自然段，原文如下：\n\n${params.body}`,
    },
  ];

  yield* streamTurns(turns, {
    temperature: 0.3,
    maxTokens: 400, // 120 字中文足够，留余量避免被截断
  });
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

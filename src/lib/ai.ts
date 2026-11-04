import { OpenAI } from "openai";

/**
 * AI 释义：用 DeepSeek（OpenAI 兼容接口）做上下文感知解释。
 *
 * 对齐 Readlang 的 Explain 设计：
 * - 带段落级上下文（选区 + 前文 + 后文分开标注），而不是只有一句话
 * - 流式输出（SSE），逐块返回
 * - 分层输出模板：单词与句子两套，句子场景「意思」置顶、语法殿后
 * - 支持 askAI：用户自由追问
 *
 * DeepSeek 需要环境变量 DEEPSEEK_API_KEY
 * 如果没配 key，降级返回提示信息而不是崩溃。
 */

function getClient(): OpenAI | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    baseURL: "https://api.deepseek.com/v1",
    apiKey,
  });
}

export type ExplainParams = {
  word: string;          // 要解释的词或短语（选区）
  context: string;       // 兜底上下文（旧调用只传一句话时使用）
  prefix?: string;       // 选区在段内的前文（可为空）
  suffix?: string;       // 选区在段内的后文（可为空）
  language?: string;     // 目标语言（正在学的语言），默认 en
  monolingual?: boolean; // true = 用目标语言解释，false = 用中文解释
  prompt?: string;       // 用户的自定义追问（对应 Readlang 的 askAI）
};

/** 选区是单词还是句子/短语（含空格即视为后者，与前端 PickCard 一致） */
function isSentenceLike(word: string): boolean {
  return /\s/.test(word.trim());
}

/**
 * 构建 system prompt（中文解释模式）
 *
 * 单词与句子两套分层模板。核心原则：
 * - 用户在读文章，首要目标是「看懂」，语言知识是次要的
 * - 句子场景：第一行就给结合语境的意译，语法要点放最后且从简
 * - 单词场景：先给本句中的意思，再给义项/语气/所在短语；不输出音标（词典卡已有）
 */
function buildSystemPrompt(language: string, monolingual: boolean, word: string): string {
  if (monolingual) {
    return `You are a language teacher helping a student learn ${language}. The student selects a word or phrase while reading; the user message marks the selection and its surrounding paragraph (before/after).
Explain the SELECTED text IN ${language.toUpperCase()} using simple, clear language.
- Lead with what it means in this context.
- If it's a sentence-like selection, give a natural interpretation first; grammar notes last and only if needed.
- You may quote the surrounding text to interpret meaning, but never explain other words from it.
Be concise but thorough.`;
  }

  if (isSentenceLike(word)) {
    return `你是一位帮中文母语者读英文文章的阅读助教。用户在读文章时划选了一个句子或短语——此刻用户最需要的是「看懂这句话」，语法和词汇讲解都是次要的。
用户消息会标注「用户选中」的文本，以及它在段落中的「前文」「后文」。请严格按以下格式用中文输出（Markdown）：

**这句话在这里的意思**
第一行就给结合语境的通顺意译。可以自然融入前后半句（例如选区到一半时，把后半句的意思补进来一起译）。

**关键词组**
只讲影响理解的关键词/词组，每个给简短中文释义；挑 2~4 个真正难的，简单的不要列。

**语气与言外之意**
说话人的态度、情绪、言外之意；实在没有可省略此节。

**语法要点**
只点真正影响理解的语法点，从简；没有就写「无特别语法难点」。此节必须放最后。

硬性要求：
- 使用粗体小标题分行，不要使用「1. 2. 3.」这类编号
- 解释对象永远是「用户选中」的部分；鼓励引用前后文来解读整句含义，但不要去解释前后文里的其他词
- 不要输出音标
- 不要先堆词性、语法再给意思
- 总长控制在 250 字以内`;
  }

  return `你是一位帮中文母语者读英文文章的阅读助教。用户在读文章时点选了一个词，想快速看懂文章、顺带学这个词。
用户消息会标注「用户选中」的词，以及它在段落中的「前文」「后文」。请严格按以下格式用中文输出（Markdown）：

**本句中的意思**
一句话直接给出这个词在此处的含义，可顺带词性（如 *v. 使欣喜*）。

**义项与语气**
常见义项、语体或语气提示（如「语气比『高兴』更强烈」）。不要输出音标——词典卡已提供。

**所在短语**
这个词与前后词搭成的短语/搭配在本句中的整体意思；若是单独一词、无固定搭配，此节可省略。

硬性要求：
- 使用粗体小标题分行，不要使用「1. 2. 3.」这类编号
- 解释对象永远是「用户选中」的词；可引用前后文帮助解读，但不要去解释前后文里的其他词
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
  const { word, context, prefix, suffix } = params;
  if (typeof prefix === "string" || typeof suffix === "string") {
    const pre = (prefix ?? "").trim();
    const suf = (suffix ?? "").trim();
    return `用户选中: "${word}"
前文: ${pre ? `"${pre}"` : "（无）"}
后文: ${suf ? `"${suf}"` : "（无）"}`;
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
  const client = getClient();
  if (!client) {
    yield "⚠️ 未配置 DEEPSEEK_API_KEY 环境变量，AI 释义不可用。\n\n请设置环境变量后重启服务：\n```\nexport DEEPSEEK_API_KEY=sk-...\n```";
    return;
  }

  const language = params.language ?? "en";
  const monolingual = params.monolingual ?? false;

  const stream = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: buildSystemPrompt(language, monolingual, params.word) },
      { role: "user", content: buildUserMessage(params) },
    ],
    stream: true,
    temperature: 0.3, // 释义要准确，不要发散
    max_tokens: 1200, // 分层模板在句子场景下需要更长输出
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
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

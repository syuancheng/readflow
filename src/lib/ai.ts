import { OpenAI } from "openai";

/**
 * AI 释义：用 DeepSeek（OpenAI 兼容接口）做上下文感知解释。
 *
 * 对齐 Readlang 的 Explain 设计：
 * - 带上下文（整句话）提问
 * - 流式输出（SSE），逐块返回
 * - 可选目标语言解释（monolingual mode）或母语解释
 * - 支持 askAI：用户自由提问
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
  word: string;          // 要解释的词或短语
  context: string;       // 所在的整句话
  language?: string;     // 目标语言（正在学的语言），默认 en
  monolingual?: boolean; // true = 用目标语言解释，false = 用中文解释
  prompt?: string;       // 用户的自定义追问（对应 Readlang 的 askAI）
};

/**
 * 构建 system prompt
 * 对齐 Readlang 的两种模式：
 * - monolingual: 用目标语言解释（博客里用户说"像有母语者在身边讨论"）
 * - bilingual: 用中文解释（适合初学者）
 */
function buildSystemPrompt(language: string, monolingual: boolean): string {
  if (monolingual) {
    return `You are a language teacher helping a student learn ${language}. Explain words and phrases IN ${language.toUpperCase()} using simple, clear language. Use examples from the given context. Be concise but thorough. If the word has multiple meanings, focus on the one that fits the context sentence.`;
  }
  return `你是一位语言教师，帮助中文母语者学习${language === "en" ? "英语" : language}。
请用中文解释用户给出的词或短语，要结合它所在的上下文句子。
- 如果词有多个义项，重点解释在当前语境下的含义
- 给出词性、音标（如有）
- 如果是习语或短语，说明用法
- 简洁但完整，用 Markdown 格式输出`;
}

/**
 * 构建 user message
 */
function buildUserMessage(params: ExplainParams): string {
  const { word, context, prompt, monolingual } = params;

  if (prompt) {
    // askAI 模式：用户自由提问
    return `Word/phrase: "${word}"
Context sentence: "${context}"
Question: ${prompt}`;
  }

  if (monolingual) {
    return `Explain the word "${word}" as used in this sentence:
"${context}"
What does it mean here? Include part of speech and a brief explanation.`;
  }

  return `请解释 "${word}" 在下面这句话中的含义：
"${context}"
请给出：词性、在当前语境下的意思、用法说明。`;
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
      { role: "system", content: buildSystemPrompt(language, monolingual) },
      { role: "user", content: buildUserMessage(params) },
    ],
    stream: true,
    temperature: 0.3, // 释义要准确，不要发散
    max_tokens: 800,
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

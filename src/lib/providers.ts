/**
 * 模型调用层：把不同厂商统一成一个「流式产出文本」的接口。
 * OpenAI / DeepSeek / 千问 / 自定义 走 OpenAI SDK；Claude 走原生 Messages SSE。
 * 这里不负责重试（由 ai.ts 与设置页统一包 withRetry），只保证抛出的错误带 status。
 */
import { OpenAI } from "openai";
import type { ResolvedProvider } from "./config";

export class ProviderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ChatTurn = { role: "system" | "user"; content: string };

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

function cleanBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function openaiClient(p: ResolvedProvider): OpenAI {
  return new OpenAI({
    apiKey: p.apiKey,
    baseURL: cleanBaseUrl(p.baseUrl) || undefined,
    timeout: 60_000,
    maxRetries: 0, // 重试统一由 withRetry 管，避免两层叠乘
  });
}

async function* openaiStream(
  p: ResolvedProvider,
  turns: ChatTurn[],
  opts: ChatOptions,
): AsyncGenerator<string> {
  const stream = await openaiClient(p).chat.completions.create({
    model: p.model,
    messages: turns,
    stream: true,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1200,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/** Anthropic Messages API 的 SSE：content_block_delta.delta.text 才是正文 */
async function* anthropicStream(
  p: ResolvedProvider,
  turns: ChatTurn[],
  opts: ChatOptions,
): AsyncGenerator<string> {
  const system = turns.filter((t) => t.role === "system").map((t) => t.content).join("\n\n");
  const messages = turns
    .filter((t) => t.role === "user")
    .map((t) => ({ role: "user" as const, content: t.content }));

  const res = await fetch(`${cleanBaseUrl(p.baseUrl)}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: opts.maxTokens ?? 1200,
      temperature: opts.temperature ?? 0.3,
      ...(system ? { system } : {}),
      messages,
      stream: true,
    }),
    signal: opts.signal ?? AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(`Claude 接口错误（HTTP ${res.status}）：${body.slice(0, 200)}`, res.status);
  }
  if (!res.body) throw new ProviderError("Claude 没有返回响应流", 502);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔；留最后一段在 buffer 里等剩余字节
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: {
          type?: string;
          delta?: { type?: string; text?: string };
          error?: { type?: string; message?: string };
        };
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // 半包/心跳，忽略
        }
        if (evt.type === "error") {
          throw new ProviderError(
            `Claude：${evt.error?.message ?? "服务繁忙"}`,
            evt.error?.type === "overloaded_error" ? 529 : 500,
          );
        }
        if (evt.type === "content_block_delta" && evt.delta?.text) {
          yield evt.delta.text;
        }
      }
    }
  }
}

export function streamChat(
  p: ResolvedProvider,
  turns: ChatTurn[],
  opts: ChatOptions = {},
): AsyncGenerator<string> {
  return p.protocol === "anthropic"
    ? anthropicStream(p, turns, opts)
    : openaiStream(p, turns, opts);
}

/**
 * P32 F3：非流式一次性调用，返回完整文本。
 * 老师笔记在后台生成，需要一次拿到全文做校验，不适合边流边拼。
 * 与 testProvider 的区别是可以传任意 turns / 参数，且两种协议都支持。
 */
export async function completeChat(
  p: ResolvedProvider,
  turns: ChatTurn[],
  opts: ChatOptions = {},
): Promise<string> {
  const temperature = opts.temperature ?? 0.3;
  const maxTokens = opts.maxTokens ?? 400;

  if (p.protocol === "openai") {
    const res = await openaiClient(p).chat.completions.create({
      model: p.model,
      messages: turns,
      temperature,
      max_tokens: maxTokens,
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  }

  const system = turns.filter((t) => t.role === "system").map((t) => t.content).join("\n\n");
  const messages = turns
    .filter((t) => t.role === "user")
    .map((t) => ({ role: "user" as const, content: t.content }));
  const res = await fetch(`${cleanBaseUrl(p.baseUrl)}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages,
    }),
    signal: opts.signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(`Claude 接口错误（HTTP ${res.status}）：${body.slice(0, 200)}`, res.status);
  }
  const data = (await res.json()) as { content?: { text?: string }[] };
  return (data.content ?? []).map((c) => c.text ?? "").join("").trim();
}

/** 设置页「测试连接」：最小 token 的一次非流式调用 */
export async function testProvider(p: ResolvedProvider): Promise<string> {
  const turns: ChatTurn[] = [
    { role: "system", content: "Reply with the single word OK." },
    { role: "user", content: "ping" },
  ];
  const opts: ChatOptions = { maxTokens: 16, temperature: 0 };

  if (p.protocol === "openai") {
    const res = await openaiClient(p).chat.completions.create({
      model: p.model,
      messages: turns,
      temperature: 0,
      max_tokens: 16,
    });
    return res.choices[0]?.message?.content?.trim() || "OK";
  }

  const res = await fetch(`${cleanBaseUrl(p.baseUrl)}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
      system: "Reply with the single word OK.",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(`Claude 接口错误（HTTP ${res.status}）：${body.slice(0, 200)}`, res.status);
  }
  const data = (await res.json()) as { content?: { text?: string }[] };
  return data.content?.[0]?.text?.trim() || "OK";
}

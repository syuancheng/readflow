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

export type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 仅 completeChat：覆盖默认的 60 秒超时（单测用来快速模拟超时，正常调用不要传） */
  timeoutMs?: number;
};

/** 非流式调用的统一超时（P32-修复）：60 秒未返回即按失败处理 */
export const COMPLETE_CHAT_TIMEOUT_MS = 60_000;

/**
 * 给一次非流式调用套上硬超时：到点 abort 掉底层请求，并按失败 reject。
 * 单独导出是为了让单测不必真的等 60 秒，就能验证「超时 = 失败」这条规则。
 * 抛出的 ProviderError 会被后台笔记任务记为失败，从而进入失败冷却。
 */
export async function runWithChatTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = COMPLETE_CHAT_TIMEOUT_MS,
  external?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError(`模型调用超时（${Math.round(timeoutMs / 1000)} 秒）`, 504));
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([run(controller.signal), guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

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
    .filter((t) => t.role !== "system")
    .map((t) => ({ role: t.role as "user" | "assistant", content: t.content }));

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

  // OpenAI SDK 分支与 Anthropic fetch 分支共用同一个 60 秒硬超时；
  // 超时抛 ProviderError，由 generateNoteNow 记为失败并进入冷却。
  return runWithChatTimeout(
    async (signal) => {
      if (p.protocol === "openai") {
        const res = await openaiClient(p).chat.completions.create(
          {
            model: p.model,
            messages: turns,
            temperature,
            max_tokens: maxTokens,
          },
          { signal },
        );
        return res.choices[0]?.message?.content?.trim() ?? "";
      }

      const system = turns.filter((t) => t.role === "system").map((t) => t.content).join("\n\n");
      const messages = turns
        .filter((t) => t.role !== "system")
        .map((t) => ({ role: t.role as "user" | "assistant", content: t.content }));
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
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new ProviderError(`Claude 接口错误（HTTP ${res.status}）：${body.slice(0, 200)}`, res.status);
      }
      const data = (await res.json()) as { content?: { text?: string }[] };
      return (data.content ?? []).map((c) => c.text ?? "").join("").trim();
    },
    opts.timeoutMs ?? COMPLETE_CHAT_TIMEOUT_MS,
    opts.signal,
  );
}

/**
 * P33：要求 JSON 输出的非流式调用（出题用）。
 * - response_format: { type: "json_object" }（DeepSeek / 千问的 OpenAI 兼容接口都支持）
 * - 复用 P32-修复的 runWithChatTimeout（60 秒硬超时）：超时抛 ProviderError(504)，
 *   由做卡流程按失败处理，**不扣每天的做卡额度**。
 * - usage 带回缓存命中 token 数（DeepSeek 的 prompt_cache_hit_tokens，或
 *   OpenAI 兼容的 prompt_tokens_details.cached_tokens），写入 card_sets。
 * Anthropic 分支不支持 response_format，改为在 system 末尾追加 JSON 要求（该分支
 * 目前没有站点配置使用，兜底实现）。
 */
export type JsonChatResult = {
  text: string;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    cacheHitTokens?: number;
  };
};

export async function completeJson(
  p: ResolvedProvider,
  turns: ChatTurn[],
  opts: ChatOptions = {},
): Promise<JsonChatResult> {
  const temperature = opts.temperature ?? 0.4;
  const maxTokens = opts.maxTokens ?? 1800;

  return runWithChatTimeout(
    async (signal): Promise<JsonChatResult> => {
      if (p.protocol === "openai") {
        const res = await openaiClient(p).chat.completions.create(
          {
            model: p.model,
            messages: turns,
            temperature,
            max_tokens: maxTokens,
            response_format: { type: "json_object" },
          },
          { signal },
        );
        const u = res.usage as
          | ({
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              prompt_cache_hit_tokens?: number;
            })
          | undefined;
        return {
          text: res.choices[0]?.message?.content?.trim() ?? "",
          usage: {
            promptTokens: u?.prompt_tokens,
            completionTokens: u?.completion_tokens,
            cacheHitTokens:
              u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens,
          },
        };
      }

      // Anthropic 兜底：接口本身有 JSON 输出保证，这里显式要求
      const system = turns.filter((t) => t.role === "system").map((t) => t.content).join("\n\n");
      const messages = turns
        .filter((t) => t.role !== "system")
        .map((t) => ({ role: t.role as "user" | "assistant", content: t.content }));
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
          ...(system ? { system: `${system}\n\nOutput only valid JSON.` } : { system: "Output only valid JSON." }),
          messages,
        }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new ProviderError(`Claude 接口错误（HTTP ${res.status}）：${body.slice(0, 200)}`, res.status);
      }
      const data = (await res.json()) as {
        content?: { text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      return {
        text: (data.content ?? []).map((c) => c.text ?? "").join("").trim(),
        usage: {
          promptTokens: data.usage?.input_tokens,
          completionTokens: data.usage?.output_tokens,
          cacheHitTokens: data.usage?.cache_read_input_tokens,
        },
      };
    },
    opts.timeoutMs ?? COMPLETE_CHAT_TIMEOUT_MS,
    opts.signal,
  );
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

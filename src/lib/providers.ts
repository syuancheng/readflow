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

/** 一次模型调用的用量（P57a）。字段缺失记 undefined，不要当成 0 */
export type ChatUsage = {
  promptTokens?: number;
  completionTokens?: number;
  /** 命中缓存的输入 token（DeepSeek: prompt_cache_hit_tokens；OpenAI 兼容: prompt_tokens_details.cached_tokens；Claude: cache_read_input_tokens） */
  cacheHitTokens?: number;
};

type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * 把各家返回的 usage 统一成 ChatUsage（纯函数，单测直接覆盖）。
 * Claude 的 input_tokens 不含缓存部分，所以 promptTokens = input + cache_read + cache_creation。
 */
export function parseUsage(u: RawUsage | null | undefined): ChatUsage {
  if (!u) return {};
  if (u.input_tokens !== undefined || u.cache_read_input_tokens !== undefined) {
    const read = num(u.cache_read_input_tokens);
    const prompt =
      num(u.input_tokens) === undefined && read === undefined
        ? undefined
        : (num(u.input_tokens) ?? 0) + (read ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
    return { promptTokens: prompt, completionTokens: num(u.output_tokens), cacheHitTokens: read };
  }
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    cacheHitTokens: num(u.prompt_cache_hit_tokens) ?? num(u.prompt_tokens_details?.cached_tokens),
  };
}

export type ChatOptions = {
  temperature?: number;
  /** 流式调用结束时回传用量（P57a）。没有拿到用量就不调用；重试时只有最后一次会调用 */
  onUsage?: (usage: ChatUsage) => void;
  /**
   * 输出上限（token）。不传 = 各调用的默认值；传 null = 流式调用不设上限：
   * OpenAI 兼容接口不带 max_tokens，由模型自己写完；Claude 接口必须带，用 CLAUDE_UNCAPPED_MAX_TOKENS。
   */
  maxTokens?: number | null;
  signal?: AbortSignal;
  /** 仅 completeChat：覆盖默认的 60 秒超时（单测用来快速模拟超时，正常调用不要传） */
  timeoutMs?: number;
};

/** Claude 接口必须带 max_tokens；「不设上限」时用这个值（远超任何一次讲解的长度） */
export const CLAUDE_UNCAPPED_MAX_TOKENS = 8192;

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
    // 让流的最后一块带上 usage（输入/输出/缓存命中 token）；DeepSeek 与 OpenAI 兼容接口都支持
    stream_options: { include_usage: true },
    temperature: opts.temperature ?? 0.3,
    // null = 不带 max_tokens（讲解用：模型写到讲完为止，只受服务商自身上限约束）
    ...(opts.maxTokens === null ? {} : { max_tokens: opts.maxTokens ?? 1200 }),
    // signal 属于 SDK 的 RequestOptions，不在请求体里；前端切词/关页时用它掐断上游流
  }, { signal: opts.signal });

  let finish: string | null = null;
  let usage: ChatUsage | null = null;
  for await (const chunk of stream) {
    if (chunk.usage) usage = parseUsage(chunk.usage as RawUsage);
    const choice = chunk.choices[0];
    const delta = choice?.delta?.content;
    if (delta) yield delta;
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  if (usage) opts.onUsage?.(usage);
  yield* endOfStream(finish === null ? null : finish === "length" ? "length" : "ok");
}

/**
 * 回答被截断时追加在末尾的说明（finish_reason = length / stop_reason = max_tokens）。
 * 以前截断是静默的：页面显示半句话，看起来像讲完了（2026-11-15 用户报告）。
 */
export const TRUNCATED_NOTICE = "\n\n（回答超出了长度上限，后面的内容没有显示。可以换个问法再问一次。）";

/**
 * 流结束时的判定：
 * - 正常结束 → 什么也不做；
 * - 到了长度上限 → 吐一句说明，让用户知道后面还有；
 * - 连接断了、没收到结束标记 → 抛 502（可重试）。上游的 streamTurns 会先发 STREAM_RESET
 *   让前端清屏，再完整重来一次，而不是把半截回答当成讲完了。
 */
function* endOfStream(end: "ok" | "length" | null): Generator<string> {
  if (end === "length") {
    yield TRUNCATED_NOTICE;
    return;
  }
  if (end === null) throw new ProviderError("模型的回答中途断开了（没有收到结束标记）", 502);
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
      // Claude 接口的 max_tokens 是必填项：不设上限时给一个远超讲解长度的值
      max_tokens: opts.maxTokens === null ? CLAUDE_UNCAPPED_MAX_TOKENS : (opts.maxTokens ?? 1200),
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
  /** message_stop 到了才算正常结束；message_delta 的 stop_reason = max_tokens 表示被截断 */
  let end: "ok" | "length" | null = null;
  let stopReason: string | null = null;
  // message_start 带输入侧用量，message_delta 带输出 token
  const rawUsage: RawUsage = {};

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
          delta?: { type?: string; text?: string; stop_reason?: string | null };
          error?: { type?: string; message?: string };
          message?: { usage?: RawUsage };
          usage?: RawUsage;
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
        if (evt.type === "message_start" && evt.message?.usage) Object.assign(rawUsage, evt.message.usage);
        if (evt.type === "message_delta" && evt.usage) Object.assign(rawUsage, evt.usage);
        if (evt.type === "message_delta" && evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.type === "message_stop") end = stopReason === "max_tokens" ? "length" : "ok";
      }
    }
  }
  if (Object.keys(rawUsage).length > 0) opts.onUsage?.(parseUsage(rawUsage));
  yield* endOfStream(end);
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
  const maxTokens = opts.maxTokens ?? 400; // 非流式调用都显式传上限，不支持 null

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
  /**
   * 模型为什么停下：stop = 写完了；length = 到了输出上限（JSON 多半没写完）；
   * 其它值原样透传；接口没给时为 null。出题失败时据此给出准确原因。
   */
  finish: string | null;
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
  // null = 不设输出上限（出题用：JSON 被截断就整个作废，宁可让模型写完）
  const maxTokens = opts.maxTokens === undefined ? 1800 : opts.maxTokens;

  return runWithChatTimeout(
    async (signal): Promise<JsonChatResult> => {
      if (p.protocol === "openai") {
        const res = await openaiClient(p).chat.completions.create(
          {
            model: p.model,
            messages: turns,
            temperature,
            ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
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
          finish: res.choices[0]?.finish_reason ?? null,
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
          max_tokens: maxTokens ?? CLAUDE_UNCAPPED_MAX_TOKENS,
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
        stop_reason?: string | null;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      return {
        text: (data.content ?? []).map((c) => c.text ?? "").join("").trim(),
        // 与 OpenAI 的叫法对齐：max_tokens → length，end_turn → stop
        finish: data.stop_reason === "max_tokens" ? "length" : data.stop_reason === "end_turn" ? "stop" : (data.stop_reason ?? null),
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { streamChat, testProvider, ProviderError, TRUNCATED_NOTICE, CLAUDE_UNCAPPED_MAX_TOKENS, completeJson } from "../../src/lib/providers";
import { isRetryableError } from "../../src/lib/retry";
import type { ResolvedProvider } from "../../src/lib/config";

const claude: ResolvedProvider = {
  id: "claude",
  label: "Claude / Anthropic",
  protocol: "anthropic",
  apiKey: "sk-ant-test",
  baseUrl: "https://api.anthropic.com/v1/",
  model: "claude-sonnet-4-5-20250929",
  source: "db",
};

/** 造一个按给定片段吐字节的响应流 */
function sseResponse(parts: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(body, { status });
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const s of gen) out += s;
  return out;
}

test("Claude SSE：拼接 content_block_delta，输出纯正文", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"本句中的意思"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"：表明"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])) as typeof fetch;
  try {
    const out = await collect(
      streamChat(claude, [{ role: "user", content: "indicate" }]),
    );
    assert.equal(out, "本句中的意思：表明");
  } finally {
    globalThis.fetch = original;
  }
});

test("Claude SSE：JSON 被网络分块切断也能正确解析", async () => {
  const original = globalThis.fetch;
  const event =
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"跨块文本"}}\n\n';
  globalThis.fetch = (async () =>
    sseResponse([event.slice(0, 42), event.slice(42, 80), event.slice(80), 'event: message_stop\ndata: {"type":"message_stop"}\n\n'])) as typeof fetch;
  try {
    const out = await collect(streamChat(claude, [{ role: "user", content: "x" }]));
    assert.equal(out, "跨块文本");
  } finally {
    globalThis.fetch = original;
  }
});

test("Claude overloaded_error → 529（可重试）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ])) as typeof fetch;
  try {
    await assert.rejects(
      collect(streamChat(claude, [{ role: "user", content: "x" }])),
      (err: unknown) => err instanceof ProviderError && err.status === 529,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Claude HTTP 401 → ProviderError 带 status，不会被当成可重试", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"error":"invalid"}', { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(
      collect(streamChat(claude, [{ role: "user", content: "x" }])),
      (err: unknown) => err instanceof ProviderError && err.status === 401,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("测试连接（非流式）能读到返回内容并去掉尾部斜杠", async () => {
  const original = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ content: [{ text: "OK" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const reply = await testProvider(claude);
    assert.equal(reply, "OK");
    assert.equal(calledUrl, "https://api.anthropic.com/v1/messages");
  } finally {
    globalThis.fetch = original;
  }
});

// ---------- 2026-11-15：回答被截断 / 中途断开不能再静默当成讲完了 ----------

const deepseek: ResolvedProvider = {
  id: "deepseek",
  label: "DeepSeek",
  protocol: "openai",
  apiKey: "sk-test",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  source: "db",
};

/** OpenAI 兼容的 SSE 片段 */
const oaChunk = (content: string | null, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat",
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
  })}\n\n`;

function sseHeaders(parts: string[]): Response {
  const res = sseResponse(parts);
  return new Response(res.body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function withFetch<T>(parts: string[], fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => sseHeaders(parts)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("OpenAI 兼容流：finish_reason = stop → 原样输出，不加任何说明", async () => {
  const out = await withFetch(
    [oaChunk("释义："), oaChunk("测试"), oaChunk(null, "stop"), "data: [DONE]\n\n"],
    () => collect(streamChat(deepseek, [{ role: "user", content: "x" }])),
  );
  assert.equal(out, "释义：测试");
});

test("OpenAI 兼容流：finish_reason = length → 末尾追加「超出长度上限」说明", async () => {
  const out = await withFetch(
    [oaChunk("难点有两处。另外，make"), oaChunk(null, "length"), "data: [DONE]\n\n"],
    () => collect(streamChat(deepseek, [{ role: "user", content: "x" }])),
  );
  assert.equal(out, "难点有两处。另外，make" + TRUNCATED_NOTICE);
});

test("OpenAI 兼容流：连接中途断开、没有结束标记 → 抛可重试的错误，不当成讲完了", async () => {
  await withFetch([oaChunk("难点有两处。另外，make")], async () => {
    await assert.rejects(
      collect(streamChat(deepseek, [{ role: "user", content: "x" }])),
      (err: unknown) => err instanceof ProviderError && err.status === 502 && isRetryableError(err),
    );
  });
});

test("Claude 流：stop_reason = max_tokens → 末尾追加说明", async () => {
  const out = await withFetch(
    [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半句"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
    () => collect(streamChat(claude, [{ role: "user", content: "x" }])),
  );
  assert.equal(out, "半句" + TRUNCATED_NOTICE);
});

test("Claude 流：没有 message_stop 就断开 → 抛可重试的错误", async () => {
  await withFetch(
    ['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半句"}}\n\n'],
    async () => {
      await assert.rejects(
        collect(streamChat(claude, [{ role: "user", content: "x" }])),
        (err: unknown) => err instanceof ProviderError && err.status === 502,
      );
    },
  );
});

test("消费方提前停止读取（前端切走）不算断开，不抛错", async () => {
  await withFetch([oaChunk("一"), oaChunk("二"), oaChunk(null, "stop")], async () => {
    const it = streamChat(deepseek, [{ role: "user", content: "x" }]);
    const first = await it.next();
    assert.equal(first.value, "一");
    await it.return(undefined);
  });
});

// ---------- 2026-11-15：讲解不设输出上限 ----------

/** 记下发出去的请求体，回一个正常结束的流 */
async function capturedBody(p: ResolvedProvider, maxTokens: number | null | undefined): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return sseHeaders(
      p.protocol === "openai"
        ? [oaChunk("好"), oaChunk(null, "stop"), "data: [DONE]\n\n"]
        : [
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ],
    );
  }) as typeof fetch;
  try {
    await collect(streamChat(p, [{ role: "user", content: "x" }], maxTokens === undefined ? {} : { maxTokens }));
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

test("OpenAI 兼容流：maxTokens = null → 请求里不带 max_tokens（模型写到讲完为止）", async () => {
  const body = await capturedBody(deepseek, null);
  assert.equal("max_tokens" in body, false);
});

test("OpenAI 兼容流：显式给了上限 / 没给（默认 1200）时照常带上", async () => {
  assert.equal((await capturedBody(deepseek, 300)).max_tokens, 300);
  assert.equal((await capturedBody(deepseek, undefined)).max_tokens, 1200);
});

test("Claude 流：max_tokens 是必填，null 时用 CLAUDE_UNCAPPED_MAX_TOKENS", async () => {
  assert.equal((await capturedBody(claude, null)).max_tokens, CLAUDE_UNCAPPED_MAX_TOKENS);
});

// ---------- 2026-11-15：出题（JSON）调用 ----------

async function jsonCall(p: ResolvedProvider, maxTokens: number | null | undefined, reply: object) {
  const original = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const out = await completeJson(p, [{ role: "user", content: "json" }], maxTokens === undefined ? {} : { maxTokens });
    return { sent, out };
  } finally {
    globalThis.fetch = original;
  }
}

const oaReply = (content: string, finish: string) => ({
  id: "x", object: "chat.completion", created: 0, model: "m",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }],
  usage: { prompt_tokens: 1, completion_tokens: 2 },
});

test("completeJson：maxTokens = null → 不带 max_tokens；带回 finish（stop / length）", async () => {
  const a = await jsonCall(deepseek, null, oaReply('{"cards":[]}', "stop"));
  assert.equal("max_tokens" in a.sent, false);
  assert.equal(a.out.finish, "stop");
  const b = await jsonCall(deepseek, 200, oaReply('{"cards":[', "length"));
  assert.equal(b.sent.max_tokens, 200);
  assert.equal(b.out.finish, "length");
});

test("completeJson（Claude）：null 时用 CLAUDE_UNCAPPED_MAX_TOKENS；stop_reason 对齐成 stop / length", async () => {
  const a = await jsonCall(claude, null, { content: [{ text: "{}" }], stop_reason: "end_turn" });
  assert.equal(a.sent.max_tokens, CLAUDE_UNCAPPED_MAX_TOKENS);
  assert.equal(a.out.finish, "stop");
  const b = await jsonCall(claude, 100, { content: [{ text: "{" }], stop_reason: "max_tokens" });
  assert.equal(b.out.finish, "length");
});

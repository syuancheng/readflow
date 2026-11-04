import { test } from "node:test";
import assert from "node:assert/strict";
import { streamChat, testProvider, ProviderError } from "../../src/lib/providers";
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
    sseResponse([event.slice(0, 42), event.slice(42, 80), event.slice(80)])) as typeof fetch;
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

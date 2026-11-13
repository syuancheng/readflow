import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  COMPLETE_CHAT_TIMEOUT_MS,
  ProviderError,
  completeChat,
  runWithChatTimeout,
} from "../../src/lib/providers";
import type { ResolvedProvider } from "../../src/lib/config";
import { canAttemptNote, settleNoteAttempt, type NoteAttemptState } from "../../src/lib/learner/note-throttle";

const turns = [
  { role: "system" as const, content: "写一段笔记" },
  { role: "user" as const, content: "统计数据" },
];

type FakeServer = { baseUrl: string; close: () => void };

/** 起一个本地假服务；handler 决定是「永不响应」还是正常返回 */
async function fakeServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<FakeServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

const provider = (baseUrl: string, protocol: "openai" | "anthropic"): ResolvedProvider => ({
  id: "custom",
  label: "自定义",
  protocol,
  apiKey: "fake-key-for-unit-test",
  baseUrl,
  model: "fake-model",
  source: "db",
});

const isTimeoutError = (e: unknown) =>
  e instanceof ProviderError && e.status === 504 && /超时/.test(e.message);

test("P32-修复 completeChat 默认超时是 60 秒", () => {
  assert.equal(COMPLETE_CHAT_TIMEOUT_MS, 60_000);
});

test("P32-修复 超时按失败抛出 ProviderError(504)，并 abort 底层请求", async () => {
  const seen: { signal: AbortSignal | null } = { signal: null };
  await assert.rejects(
    runWithChatTimeout((signal) => {
      seen.signal = signal;
      return new Promise<string>(() => { /* 永不完成 */ });
    }, 25),
    isTimeoutError,
  );
  assert.equal(seen.signal?.aborted, true, "超时必须把 signal abort 掉，避免挂着连接");
});

test("P32-修复 未超时的调用正常返回，定时器被清掉", async () => {
  const r = await runWithChatTimeout(async () => "笔记内容", 30);
  assert.equal(r, "笔记内容");
});

test("P32-修复 超时异常按失败结算后立刻进入 1 小时冷却（note-generator 的接线）", async () => {
  // generateNote 把 completeChat 放在 try 里，finally 用 succeeded=false 结算尝试；
  // 超时抛错时 succeeded 保持 false，于是 noteBlockReason 会挡住后续请求。
  let state: NoteAttemptState | null = null;
  let succeeded = false;
  try {
    await runWithChatTimeout(() => new Promise<string>(() => { /* 永不完成 */ }), 20);
    succeeded = true;
  } catch (err) {
    assert.ok(isTimeoutError(err), "超时必须是可识别的失败，不能静默吞掉");
  } finally {
    state = settleNoteAttempt(state, { success: succeeded, now: Date.now() });
  }
  assert.equal(succeeded, false);
  assert.equal(canAttemptNote(state, Date.now()), false, "超时之后不能再打模型");
});

test("P32-修复 外部 signal 也能中途取消（原有能力不回归）", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(
    runWithChatTimeout(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by caller")));
        }),
      500,
      ac.signal,
    ),
    /aborted by caller/,
  );
});

test("P32-修复 OpenAI 非流式：挂住的模型在超时后按失败处理", async () => {
  const s = await fakeServer(() => { /* 永不响应 */ });
  try {
    await assert.rejects(
      completeChat(provider(s.baseUrl, "openai"), turns, { timeoutMs: 60 }),
      isTimeoutError,
    );
  } finally {
    s.close();
  }
});

test("P32-修复 Anthropic 非流式：挂住的模型在超时后按失败处理", async () => {
  const s = await fakeServer(() => { /* 永不响应 */ });
  try {
    await assert.rejects(
      completeChat(provider(s.baseUrl, "anthropic"), turns, { timeoutMs: 60 }),
      isTimeoutError,
    );
  } finally {
    s.close();
  }
});

test("P32-修复 未超时时 OpenAI 非流式返回不变（trim 后的文本）", async () => {
  const s = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "fake", object: "chat.completion", created: 0, model: "fake-model",
      choices: [{ index: 0, message: { role: "assistant", content: "  一段中文笔记  " }, finish_reason: "stop" }],
    }));
  });
  try {
    assert.equal(await completeChat(provider(s.baseUrl, "openai"), turns), "一段中文笔记");
  } finally {
    s.close();
  }
});

test("P32-修复 未超时时 Anthropic 非流式返回不变", async () => {
  const s = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ text: "  另一段中文笔记  " }] }));
  });
  try {
    assert.equal(await completeChat(provider(s.baseUrl, "anthropic"), turns), "另一段中文笔记");
  } finally {
    s.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffDelayMs,
  errorStatus,
  isRetryableError,
  sleepWithSignal,
  withRetry,
} from "../../src/lib/retry";

const noSleep = async () => {};

test("限流 / 网关 / 模型繁忙 → 重试", () => {
  for (const status of [408, 429, 500, 502, 503, 504, 529]) {
    assert.equal(isRetryableError({ status }), true, `HTTP ${status} 应可重试`);
  }
  assert.equal(isRetryableError({ response: { status: 503 } }), true);
  assert.equal(isRetryableError(Object.assign(new Error("overloaded_error: 模型繁忙"), { status: 529 })), true);
  assert.equal(isRetryableError(new Error("fetch failed: ECONNRESET")), true);
  assert.equal(isRetryableError(new Error("Request timed out")), true);
  assert.equal(isRetryableError(new TypeError("模型繁忙，请稍后再试")), true);
});

test("Key 错 / 参数错 / 没权限 → 不重试", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableError({ status }), false, `HTTP ${status} 不该重试`);
  }
  assert.equal(isRetryableError(Object.assign(new Error("Incorrect API key provided"), { status: 401 })), false);
});

test("errorStatus 兼容 SDK 的多种字段", () => {
  assert.equal(errorStatus({ status: 429 }), 429);
  assert.equal(errorStatus({ statusCode: 503 }), 503);
  assert.equal(errorStatus({ response: { status: 500 } }), 500);
  assert.equal(errorStatus({ code: "429" }), 429);
  assert.equal(errorStatus({ code: "ECONNRESET" }), undefined);
  assert.equal(errorStatus(new Error("boom")), undefined);
});

test("退避指数增长、有上限、抖动可关闭", () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 800, factor: 2, jitter: 0, random: () => 0.5 };
  assert.equal(backoffDelayMs(0, opts), 100);
  assert.equal(backoffDelayMs(1, opts), 200);
  assert.equal(backoffDelayMs(2, opts), 400);
  assert.equal(backoffDelayMs(9, opts), 800);
  const jittered = backoffDelayMs(0, { baseDelayMs: 1000, jitter: 0.2, random: () => 1 });
  assert.ok(jittered >= 1000 && jittered <= 1200);
});

test("前两次失败第三次成功 → 返回结果，共调用 3 次", async () => {
  let calls = 0;
  const retried: number[] = [];
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("503 busy"), { status: 503 });
      return "ok";
    },
    { attempts: 3, sleep: noSleep, onRetry: (i) => retried.push(i.attempt) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(retried, [1, 2]);
});

test("不可重试错误只调用一次", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw Object.assign(new Error("invalid api key"), { status: 401 });
      },
      { attempts: 5, sleep: noSleep },
    ),
    /invalid api key/,
  );
  assert.equal(calls, 1);
});

test("重试用尽后抛出最后一次错误", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error(`fail-${calls}`);
      },
      { attempts: 3, sleep: noSleep },
    ),
    /fail-3/,
  );
  assert.equal(calls, 3);
});

test("自定义 shouldRetry 可覆盖默认判定", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("nope");
      },
      { attempts: 4, sleep: noSleep, shouldRetry: () => false },
    ),
    /nope/,
  );
  assert.equal(calls, 1);
});

test("sleepWithSignal：正常等完返回 true，已取消或中途 abort 立刻返回 false", async () => {
  assert.equal(await sleepWithSignal(10), true);

  const already = new AbortController();
  already.abort();
  const t0 = Date.now();
  assert.equal(await sleepWithSignal(5000, already.signal), false);
  assert.ok(Date.now() - t0 < 100);

  const mid = new AbortController();
  const t1 = Date.now();
  setTimeout(() => mid.abort(), 15);
  assert.equal(await sleepWithSignal(5000, mid.signal), false);
  assert.ok(Date.now() - t1 < 200);
});

test("withRetry：退避等待期间被 abort 立刻结束，不再发起下一次重试", async () => {
  const ac = new AbortController();
  let calls = 0;
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw Object.assign(new Error("429 rate limit"), { status: 429 });
      },
      { attempts: 5, baseDelayMs: 5000, jitter: 0, signal: ac.signal },
    ),
    /429 rate limit/,
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - t0 < 200);
});

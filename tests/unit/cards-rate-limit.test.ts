import assert from "node:assert/strict";
import test from "node:test";
import {
  createRateLimiter,
  MIN_INTERVAL_MS,
  WINDOW_LONG_MAX,
  WINDOW_LONG_MS,
  WINDOW_SHORT_MAX,
  WINDOW_SHORT_MS,
} from "../../src/lib/cards/rate-limit";

test("常量：10 秒 20 次、60 秒 40 次、间隔 500ms（墨墨文档）", () => {
  assert.deepEqual([WINDOW_SHORT_MS, WINDOW_SHORT_MAX, WINDOW_LONG_MS, WINDOW_LONG_MAX, MIN_INTERVAL_MS], [10_000, 20, 60_000, 40, 500]);
});

test("没请求过：马上可以", () => {
  const rl = createRateLimiter();
  assert.equal(rl.nextAt(1000), 1000);
});

test("两次请求之间至少 500ms", () => {
  const rl = createRateLimiter();
  rl.record(1000);
  assert.equal(rl.nextAt(1000), 1500);
  assert.equal(rl.nextAt(1200), 1500);
  assert.equal(rl.nextAt(1500), 1500);
  assert.equal(rl.nextAt(2000), 2000);
});

test("短窗口：10 秒内第 21 个请求要等到最早那个滑出窗口", () => {
  const rl = createRateLimiter({ minIntervalMs: 0 });
  for (let i = 0; i < 20; i++) rl.record(1000 + i);
  assert.equal(rl.nextAt(1100), 1000 + 10_000);
  assert.equal(rl.nextAt(11_000), 11_000);
});

test("长窗口：60 秒内第 41 个请求要等", () => {
  const rl = createRateLimiter({ minIntervalMs: 0, windowShortMax: 1000 });
  for (let i = 0; i < 40; i++) rl.record(i * 100);
  assert.equal(rl.nextAt(4000), 60_000);
});

test("滑动窗口只保留窗口内的记录", () => {
  const rl = createRateLimiter({ minIntervalMs: 0 });
  for (let i = 0; i < 20; i++) rl.record(i);
  rl.record(200_000);
  assert.equal(rl.nextAt(200_000), 200_000);
});

test("模拟连续推送：按 nextAt 排队，任何时刻都不超限", () => {
  const rl = createRateLimiter();
  const times: number[] = [];
  let now = 0;
  for (let i = 0; i < 100; i++) {
    now = rl.nextAt(now);
    rl.record(now);
    times.push(now);
  }
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 500);
  for (let i = 0; i < times.length; i++) {
    const in10 = times.filter((t) => t > times[i] - 10_000 && t <= times[i]).length;
    const in60 = times.filter((t) => t > times[i] - 60_000 && t <= times[i]).length;
    assert.ok(in10 <= 20, `10 秒窗口 ${in10}`);
    assert.ok(in60 <= 40, `60 秒窗口 ${in60}`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { enterForeground, foregroundActive, waitForForegroundIdle } from "../../src/lib/ai-priority";
import { createLimiter } from "../../src/lib/request-gate";

const tick = () => new Promise((r) => setImmediate(r));

test("前台没有讲解：后台立刻放行", async () => {
  assert.equal(foregroundActive(), 0);
  await waitForForegroundIdle(10_000); // 不应该等
});

test("前台讲解期间后台等待，release 后继续", async () => {
  const release = enterForeground();
  let resumed = false;
  const p = waitForForegroundIdle(10_000).then(() => { resumed = true; });
  await tick();
  assert.equal(resumed, false);
  release();
  await p;
  assert.equal(resumed, true);
  assert.equal(foregroundActive(), 0);
});

test("多个前台讲解：全部结束才放行；release 幂等", async () => {
  const a = enterForeground();
  const b = enterForeground();
  let resumed = false;
  const p = waitForForegroundIdle(10_000).then(() => { resumed = true; });
  a(); a(); // 重复 release 不能多减
  await tick();
  assert.equal(foregroundActive(), 1);
  assert.equal(resumed, false);
  b();
  await p;
  assert.equal(resumed, true);
});

test("等太久就不等了：到点照常往下跑", async () => {
  const release = enterForeground();
  const t0 = Date.now();
  await waitForForegroundIdle(30);
  assert.ok(Date.now() - t0 >= 25);
  assert.equal(foregroundActive(), 1, "超时放行不影响前台计数");
  release();
});

test("release 漏调：ttl 到点自动归还，不会永远挡住后台", async () => {
  enterForeground(30);
  assert.equal(foregroundActive(), 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(foregroundActive(), 0);
  await waitForForegroundIdle(10_000);
});

test("串行队列 + 前台让路：多个后台任务排队，前台释放后一次只唤醒一个（无惊群）", async () => {
  const queue = createLimiter(1);
  const release = enterForeground();
  let inflight = 0;
  let maxInflight = 0;
  const order: number[] = [];

  const runBg = (id: number) =>
    queue(async () => {
      await waitForForegroundIdle(10_000);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      order.push(id);
      await new Promise((r) => setTimeout(r, 15));
      inflight--;
    });

  const jobs = [runBg(1), runBg(2), runBg(3)];
  await tick();
  assert.deepEqual(order, [], "前台讲解期间三个后台任务都不应启动");
  release();
  await Promise.all(jobs);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(maxInflight, 1, "释放后严格串行，不会同时打出 3 个请求");
});

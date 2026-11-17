import assert from "node:assert/strict";
import test from "node:test";
import { createCoalescer, createLimiter } from "../../src/lib/request-gate";

const tick = () => new Promise<void>((r) => setImmediate(r));

type Gate = { promise: Promise<void>; resolve: () => void };
function deferred(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

test("P41 createLimiter：同时最多 max 个在跑，其余先进先出排队，跑完一个放进下一个", async () => {
  const limit = createLimiter(2);
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started: number[] = [];
  const results = gates.map((g, i) => limit(async () => { started.push(i); await g.promise; return i * 10; }));
  await tick();
  assert.deepEqual(started, [0, 1], "只先跑前两个");
  gates[0].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2], "第一个跑完才放第三个进来");
  gates[2].resolve();
  gates[1].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[3].resolve();
  assert.deepEqual(await Promise.all(results), [0, 10, 20, 30]);
});

test("P41 createLimiter：任务出错也要释放名额，错误原样抛给调用方", async () => {
  const limit = createLimiter(1);
  const failing = limit(async () => { throw new Error("boom"); });
  const after = limit(async () => "ok");
  await assert.rejects(failing, /boom/);
  assert.equal(await after, "ok");
});

test("P41 createCoalescer：没在跑就立刻跑；正在跑时后来的调用合并成「跑完再补一次」", async () => {
  let runs = 0;
  const gates: Gate[] = [];
  const kick = createCoalescer(async () => {
    runs++;
    const g = deferred();
    gates.push(g);
    await g.promise;
  });
  const first = kick();
  await tick();
  assert.equal(runs, 1);
  // 在跑的时候连续来了 5 次：只会合并成 1 次补发
  const rest = [kick(), kick(), kick(), kick(), kick()];
  await tick();
  assert.equal(runs, 1, "在跑的这一轮没结束，不会并发再发");
  gates[0].resolve();
  await first;
  await tick();
  assert.equal(runs, 2, "补发了 1 次，不是 5 次");
  gates[1].resolve();
  await Promise.all(rest);
  assert.equal(runs, 2);
  // 全部结束后，再来一次又能正常跑
  const again = kick();
  await tick();
  assert.equal(runs, 3);
  gates[2].resolve();
  await again;
});

test("P41 createCoalescer：run 抛错不会卡死后续调用，也不会抛给调用方", async () => {
  let n = 0;
  const kick = createCoalescer(async () => {
    n++;
    if (n === 1) throw new Error("网络断了");
  });
  await kick();
  await kick();
  assert.equal(n, 2);
});

test("P41 createCoalescer：await 的调用方拿到的是「覆盖了自己那次」的结果（补发那一轮完成后才返回）", async () => {
  const order: string[] = [];
  const gates = [deferred(), deferred()];
  let i = 0;
  const kick = createCoalescer(async () => {
    const g = gates[i++];
    await g.promise;
    order.push(`done${i}`);
  });
  const a = kick();
  await tick();
  const b = kick();
  gates[0].resolve();
  await a;
  order.push("a-returned");
  gates[1].resolve();
  await b;
  order.push("b-returned");
  assert.deepEqual(order, ["done1", "a-returned", "done2", "b-returned"]);
});

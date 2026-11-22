import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TOASTS,
  addToast,
  cardViewHref,
  createCardJobTracker,
  removeToast,
  toastOf,
  type CardStateLite,
  type CardToast,
} from "../../src/lib/card-jobs";

const st = (over: Partial<CardStateLite> = {}): CardStateLite => ({
  state: "generating", setId: "s1", count: 0, error: null, wordId: null, ...over,
});

test("P43 cardViewHref：和右栏按钮里的「查看」是同一个地址", () => {
  assert.equal(cardViewHref("abc-123"), "/words?status=pending&word=abc-123");
  assert.equal(cardViewHref(null), "/words?status=pending&word=");
  assert.equal(cardViewHref("a b&c"), "/words?status=pending&word=a%20b%26c");
});

test("P43 toastOf：做完 / 失败才弹；还在跑、还没开始不弹", () => {
  const job = { contextId: "c1", word: "fight", setId: "s1" };
  assert.equal(toastOf(job, st({ state: "generating" })), null);
  assert.equal(toastOf(job, st({ state: "none" })), null);
  assert.deepEqual(toastOf(job, st({ state: "ready", count: 2, wordId: "w9" })), {
    id: "c1", kind: "ready", word: "fight", count: 2, href: "/words?status=pending&word=w9", detail: null,
  });
  assert.equal(toastOf(job, st({ state: "pushed", count: 3, wordId: "w9" }))?.kind, "ready");
  assert.deepEqual(toastOf(job, st({ state: "failed", error: "模型没有返回合法的 JSON" })), {
    id: "c1", kind: "failed", word: "fight", count: 0, href: null, detail: "模型没有返回合法的 JSON",
  });
});

test("P43 toastOf：只认自己这一组——状态里是别的组（比如上一组遗留的已完成）不弹", () => {
  const job = { contextId: "c1", word: "fight", setId: "s2" };
  assert.equal(toastOf(job, st({ state: "ready", setId: "s1", count: 2 })), null);
  assert.equal(toastOf(job, st({ state: "ready", setId: "s2", count: 2 }))?.kind, "ready");
  // 登记时没有 setId（只知道在生成）：不挑
  assert.equal(toastOf({ contextId: "c1", word: "x" }, st({ state: "ready", setId: "s1" }))?.kind, "ready");
});

/** 假定时器：schedule 只记下回调，测试里手动「过一个周期」 */
function harness(states: Array<CardStateLite | null | "throw">, opts: { maxPolls?: number } = {}) {
  const calls: string[] = [];
  const toasts: CardToast[] = [];
  let pending: (() => void) | null = null;
  let cancelled = 0;
  const tracker = createCardJobTracker({
    fetchState: async (id) => {
      calls.push(id);
      const next = states.shift();
      if (next === "throw") throw new Error("网络断了");
      return next ?? null;
    },
    schedule: (fn) => {
      pending = fn;
      return () => { cancelled++; pending = null; };
    },
    onToast: (t) => toasts.push(t),
    maxPolls: opts.maxPolls,
  });
  const tick = async () => {
    const fn = pending;
    pending = null;
    fn?.();
    await new Promise((r) => setImmediate(r));
  };
  return { tracker, calls, toasts, tick, hasPending: () => pending !== null, cancelled: () => cancelled };
}

test("P43 跟踪器：一直查到做完才弹一次通知，弹完停止轮询", async () => {
  const h = harness([st(), st(), st({ state: "ready", count: 2, wordId: "w1" })]);
  h.tracker.track({ contextId: "c1", word: "fight", setId: "s1" });
  assert.equal(h.calls.length, 0, "登记时不立刻查，等第一个周期");
  await h.tick(); assert.equal(h.toasts.length, 0);
  await h.tick(); assert.equal(h.toasts.length, 0);
  await h.tick();
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].kind, "ready");
  assert.equal(h.toasts[0].count, 2);
  assert.equal(h.hasPending(), false, "弹完不再排下一次");
  assert.equal(h.tracker.isTracking("c1"), false);
});

test("P43 跟踪器：同一个词重复登记不会多开一路轮询", async () => {
  const h = harness([st({ state: "ready", count: 1, wordId: "w1" })]);
  h.tracker.track({ contextId: "c1", word: "fight" });
  h.tracker.track({ contextId: "c1", word: "fight" });
  h.tracker.track({ contextId: "c1", word: "fight" });
  await h.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.toasts.length, 1);
});

test("P43 跟踪器：失败也弹；网络抖动（抛错 / 返回空）不算失败，下一轮继续", async () => {
  const h = harness(["throw", null, st({ state: "failed", error: "超时" })]);
  h.tracker.track({ contextId: "c1", word: "fight" });
  await h.tick(); await h.tick();
  assert.equal(h.toasts.length, 0);
  assert.equal(h.hasPending(), true);
  await h.tick();
  assert.deepEqual(h.toasts.map((t) => [t.kind, t.detail]), [["failed", "超时"]]);
});

test("P43 跟踪器：最多查 maxPolls 次，之后放弃（不无限轮询）", async () => {
  const h = harness(Array.from({ length: 10 }, () => st()), { maxPolls: 3 });
  h.tracker.track({ contextId: "c1", word: "fight" });
  await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.calls.length, 3);
  assert.equal(h.hasPending(), false);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.tracker.isTracking("c1"), false);
});

test("P43 跟踪器：stopAll 取消所有轮询", async () => {
  const h = harness([st()]);
  h.tracker.track({ contextId: "c1", word: "a" });
  h.tracker.stopAll();
  assert.equal(h.cancelled(), 1);
  assert.equal(h.tracker.isTracking("c1"), false);
});

test("P43 通知列表：新的在最上面，同一个词只留一条，最多 3 条，可单独关掉", () => {
  const mk = (id: string): CardToast => ({ id, kind: "ready", word: id, count: 2, href: "/x", detail: null });
  let list: CardToast[] = [];
  for (const id of ["a", "b", "c", "d"]) list = addToast(list, mk(id));
  assert.deepEqual(list.map((t) => t.id), ["d", "c", "b"]);
  assert.equal(list.length, MAX_TOASTS);
  list = addToast(list, { ...mk("c"), count: 5 }); // 同一个词再来一条：替换并顶到最上面
  assert.deepEqual(list.map((t) => [t.id, t.count]), [["c", 5], ["d", 2], ["b", 2]]);
  assert.deepEqual(removeToast(list, "d").map((t) => t.id), ["c", "b"]);
  assert.deepEqual(removeToast(list, "zzz").map((t) => t.id), ["c", "d", "b"]);
});

test("跟踪器 onState：每次查到状态都广播（含最后一次 ready），查不到 / 抛错不广播；订阅者抛错不打断跟踪", async () => {
  const seen: [string, string][] = [];
  const toasts: CardToast[] = [];
  const states: Array<CardStateLite | null | "throw"> = [st(), "throw", null, st({ state: "ready", count: 1, wordId: "w1" })];
  let pending: (() => void) | null = null;
  const tracker = createCardJobTracker({
    fetchState: async () => {
      const next = states.shift();
      if (next === "throw") throw new Error("断网");
      return next ?? null;
    },
    schedule: (fn) => { pending = fn; return () => { pending = null; }; },
    onToast: (t) => toasts.push(t),
    onState: (id, s) => {
      seen.push([id, s.state]);
      if (seen.length === 1) throw new Error("订阅者出错");
    },
  });
  const tick = async () => { const fn = pending; pending = null; fn?.(); await new Promise((r) => setImmediate(r)); };
  tracker.track({ contextId: "c1", word: "fight", setId: "s1" });
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(seen, [["c1", "generating"], ["c1", "ready"]]);
  assert.equal(toasts.length, 1);
});

test("跟踪器 onState：状态里是别的组时仍广播（过滤交给订阅者），但不弹通知", async () => {
  const seen: string[] = [];
  const toasts: CardToast[] = [];
  let pending: (() => void) | null = null;
  const tracker = createCardJobTracker({
    fetchState: async () => st({ state: "ready", setId: "old", count: 2 }),
    schedule: (fn) => { pending = fn; return () => { pending = null; }; },
    onToast: (t) => toasts.push(t),
    onState: (_id, s) => seen.push(`${s.state}:${s.setId}`),
    maxPolls: 1,
  });
  tracker.track({ contextId: "c1", word: "fight", setId: "new" });
  const fn = pending as (() => void) | null;
  fn?.();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["ready:old"]);
  assert.equal(toasts.length, 0);
});

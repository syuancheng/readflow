import assert from "node:assert/strict";
import test from "node:test";
import { LruCache, caseCandidates } from "../../src/lib/dict-cache";
import { formatLagLine, lagMs } from "../../src/lib/loop-lag";

test("P41 caseCandidates：原样、小写、首字母大写、全大写，去重，原样优先", () => {
  assert.deepEqual(caseCandidates("Running"), ["Running", "running", "RUNNING"]);
  assert.deepEqual(caseCandidates("running"), ["running", "Running", "RUNNING"]);
  assert.deepEqual(caseCandidates("NASA"), ["NASA", "nasa", "Nasa"]);
  assert.deepEqual(caseCandidates("iPhone"), ["iPhone", "iphone", "Iphone", "IPHONE"]);
  assert.deepEqual(caseCandidates("I"), ["I", "i"]);
  assert.deepEqual(caseCandidates("goal-oriented"), ["goal-oriented", "Goal-oriented", "GOAL-ORIENTED"]);
  assert.deepEqual(caseCandidates(""), [""]);
});

test("P41 LruCache：命中的条目变成最新；超过容量丢掉最久没用的", () => {
  const c = new LruCache<number>(3);
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  assert.equal(c.get("a"), 1); // a 变最新，现在最旧的是 b
  c.set("d", 4);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
  assert.equal(c.get("d"), 4);
  assert.equal(c.size, 3);
});

test("P41 LruCache：null 值也是缓存（词不在词频表里，不要每次重查）；覆盖写不增加条目", () => {
  const c = new LruCache<number | null>(2);
  c.set("zorb", null);
  assert.equal(c.get("zorb"), null);
  assert.equal(c.get("missing"), undefined);
  c.set("x", 1); c.set("x", 2);
  assert.equal(c.get("x"), 2);
  assert.equal(c.size, 2);
});

test("P41 lagMs / formatLagLine：定时器晚醒了多少就是被占住了多久", () => {
  assert.equal(lagMs(1000, 1200, 200), 0);
  assert.equal(lagMs(1000, 1700, 200), 500);
  assert.equal(lagMs(1000, 1100, 200), 0, "时钟回拨 / 早醒不算负数");
  const line = formatLagLine({ lag: 1234.6, rssMb: 412.3, heapUsedMb: 150.2, freeMb: 88.9, totalMb: 1990.4, load1: 1.5 });
  assert.equal(line, "[perf] 事件循环被占住 1235ms；进程内存 412MB（堆 150MB），系统可用 89/1990MB，1 分钟负载 1.50");
});

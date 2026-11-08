import assert from "node:assert/strict";
import test from "node:test";
import { currentBlockIdx, scrollProgress, shouldAutoResume } from "../../src/lib/read-progress";

const M = { innerHeight: 800, scrollHeight: 4000 };

test("回归：停在顶部不是 100%（旧版打开即写满的 bug）", () => {
  assert.equal(scrollProgress({ ...M, scrollY: 0 }), 0);
  assert.ok(scrollProgress({ ...M, scrollY: 0 }) < 1);
});

test("滚动到中段按可滚动区成比例", () => {
  // scrollable = 3200
  assert.equal(scrollProgress({ ...M, scrollY: 1600 }), 0.5);
  assert.equal(scrollProgress({ ...M, scrollY: 800 }), 0.25);
});

test("滚到底为 1，且不会超过 1", () => {
  assert.equal(scrollProgress({ ...M, scrollY: 3200 }), 1);
  assert.equal(scrollProgress({ ...M, scrollY: 5000 }), 1);
  // 差几 px 到底也算到底（亚像素容差）
  assert.equal(scrollProgress({ ...M, scrollY: 3195 }), 1);
});

test("往回翻进度会下降（P18 要求进度可回退）", () => {
  const deep = scrollProgress({ ...M, scrollY: 2400 });
  const back = scrollProgress({ ...M, scrollY: 800 });
  assert.ok(back < deep);
});

test("内容不足一屏直接算 100%", () => {
  assert.equal(scrollProgress({ scrollY: 0, innerHeight: 800, scrollHeight: 700 }), 1);
  assert.equal(scrollProgress({ scrollY: 0, innerHeight: 800, scrollHeight: 805 }), 1);
});

test("非法 / 异常输入不产生 NaN 或负数", () => {
  assert.equal(scrollProgress({ ...M, scrollY: -50 }), 0);
  assert.equal(scrollProgress({ ...M, scrollY: Number.NaN }), 0);
  assert.equal(scrollProgress({ scrollY: 0, innerHeight: 0, scrollHeight: 4000 }), 0);
  assert.equal(scrollProgress({ ...M, scrollY: 100, scrollHeight: Number.POSITIVE_INFINITY }), 0);
});

test("currentBlockIdx：空列表 / 线在首块之前返回 -1", () => {
  assert.equal(currentBlockIdx([], 500), -1);
  assert.equal(currentBlockIdx([{ idx: 0, top: 800 }], 500), -1);
});

test("currentBlockIdx：取读到线以上的最大 idx，乱序也正确", () => {
  const blocks = [
    { idx: 3, top: 300 },
    { idx: 0, top: 0 },
    { idx: 9, top: 900 },
    { idx: 5, top: 500 },
  ];
  assert.equal(currentBlockIdx(blocks, 450), 3);
  assert.equal(currentBlockIdx(blocks, 950), 9);
  assert.equal(currentBlockIdx(blocks, 1000), 9);
});

test("shouldAutoResume：中途书签才续读", () => {
  assert.equal(
    shouldAutoResume({ completedAt: null, readIdx: 40, readRatio: 0.4, maxIdx: 100 }),
    true,
  );
});

test("shouldAutoResume：文末书签 / 100% / 已读完 / 没读过都不续读", () => {
  const base = { completedAt: null, readIdx: 100, readRatio: 1, maxIdx: 100 };
  assert.equal(shouldAutoResume(base), false, "文末书签会锁死 100%");
  assert.equal(shouldAutoResume({ ...base, readIdx: 30 }), false, "进度已到底");
  assert.equal(shouldAutoResume({ ...base, readIdx: 30, readRatio: 0.3, completedAt: Date.now() }), false);
  assert.equal(shouldAutoResume({ ...base, readIdx: null }), false);
  assert.equal(shouldAutoResume({ ...base, readIdx: -1 }), false);
});

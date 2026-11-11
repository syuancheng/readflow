import { test } from "node:test";
import assert from "node:assert/strict";
import { findCoveringRange } from "../../src/lib/annotation-range";

const r = (id: string, paragraphId: string, start: number, end: number) => ({
  id,
  paragraphId,
  start,
  end,
});

/** 短语 / 整句批注：点区间里的任意一个词都应该命中整条 */
test("控制变量一：词完整落在短语区间里 → 命中整条短语", () => {
  const ranges = [r("phrase", "p1", 10, 30)];
  assert.equal(findCoveringRange(ranges, "p1", 10, 18)?.id, "phrase");
  assert.equal(findCoveringRange(ranges, "p1", 20, 30)?.id, "phrase");
  assert.equal(findCoveringRange(ranges, "p1", 12, 13)?.id, "phrase"); // 词间空白
});

test("控制变量二：只是相邻或部分重叠 → 不命中", () => {
  const ranges = [r("phrase", "p1", 10, 20)];
  assert.equal(findCoveringRange(ranges, "p1", 5, 12), undefined);
  assert.equal(findCoveringRange(ranges, "p1", 18, 25), undefined);
  assert.equal(findCoveringRange(ranges, "p1", 20, 25), undefined);
});

test("控制变量三：不同段落不算命中", () => {
  const ranges = [r("phrase", "p1", 0, 40)];
  assert.equal(findCoveringRange(ranges, "p2", 0, 5), undefined);
});

test("控制变量四：多条批注重叠 → 取区间最短、起点最早的一条", () => {
  const ranges = [
    r("whole-sentence", "p1", 0, 60),
    r("long-first", "p1", 8, 24),
    r("short", "p1", 10, 20),
    r("also-short", "p1", 12, 22),
  ];
  assert.equal(findCoveringRange(ranges, "p1", 13, 17)?.id, "short");
});

test("控制变量五：单词批注自身也命中（区间正好等于这个词）", () => {
  const ranges = [r("word", "p1", 5, 11)];
  assert.equal(findCoveringRange(ranges, "p1", 5, 11)?.id, "word");
  assert.equal(findCoveringRange(ranges, "p1", 4, 11), undefined);
});

test("控制变量六：空列表 / 完全不相交 → undefined", () => {
  assert.equal(findCoveringRange([], "p1", 0, 5), undefined);
  assert.equal(findCoveringRange([r("word", "p1", 5, 11)], "p1", 30, 35), undefined);
});

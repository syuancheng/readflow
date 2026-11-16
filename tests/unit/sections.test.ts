import assert from "node:assert/strict";
import test from "node:test";
import {
  countWords,
  planSections,
  SECTION_TAIL_MIN_WORDS,
  SECTION_TARGET_WORDS,
} from "../../src/lib/sections";

/**
 * 分段小结的分区规则（用户明确要求）：
 *  - 按累计词数切，不按固定段数切（英语自然段长度差异极大）
 *  - **绝不拆自然段**：标记只能落在段末；一段 200 词就按 200 算，
 *    一段 1000 词就按 1000 算，不会因为超过目标被切开
 *  - 文末残余太少时并入上一区间
 *  - 2026-11-16：目标从 300 词降到 100 词，更细粒度的小结
 */

const para = (idx: number, words: number) => ({
  idx,
  content: Array.from({ length: words }, (_, i) => `w${i % 7}`).join(" "),
});

test("阈值配置：目标 100 词，尾部下限 40 且小于目标", () => {
  assert.equal(SECTION_TARGET_WORDS, 100);
  assert.equal(SECTION_TAIL_MIN_WORDS, 40);
  assert.ok(SECTION_TAIL_MIN_WORDS < SECTION_TARGET_WORDS);
});

test("countWords：连字符与撇号算一个词，标点不计", () => {
  assert.equal(countWords("Hello, world!"), 2);
  assert.equal(countWords("don't stop well-known 2026"), 4);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   \n  "), 0);
});

test("每段 100 词 × 7 段：每段各自成区，最后一段也够 100 不并入", () => {
  const ps = Array.from({ length: 7 }, (_, i) => para(i, 100));
  const secs = planSections(ps);
  assert.equal(secs.length, 7, `区间数：${JSON.stringify(secs)}`);
  assert.deepEqual(
    secs.map((s) => [s.startIdx, s.endIdx]),
    [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]],
  );
  assert.ok(secs.every((s) => s.words === 100));
});

test("每段 30 词 × 20 段：短线段落累到第 4 段才够 100", () => {
  const ps = Array.from({ length: 20 }, (_, i) => para(i, 30));
  const secs = planSections(ps);
  assert.deepEqual(
    secs.map((s) => [s.startIdx, s.endIdx]),
    [[0, 3], [4, 7], [8, 11], [12, 15], [16, 19]],
    "每 4 段累计 120 词达到 100 目标后截断",
  );
  assert.ok(secs.every((s) => s.words >= SECTION_TARGET_WORDS));
});

test("单段 200 词：整段自成一个区间，绝不拆成两个 100", () => {
  const ps = [para(0, 200), para(1, 50)];
  const secs = planSections(ps);
  assert.deepEqual([secs[0].startIdx, secs[0].endIdx], [0, 0]);
  assert.equal(secs[0].words, 200, "200 词的一段不能被切成两个区间");
  // 尾部 50 词 ≥ 40 下限，单独成区
  assert.deepEqual([secs[1].startIdx, secs[1].endIdx], [1, 1]);
});

test("单段 1000 词：按 1000 算，绝不拆成十个区间", () => {
  const ps = [para(0, 1000), para(1, 60)];
  const secs = planSections(ps);
  assert.equal(secs.length, 2);
  assert.deepEqual([secs[0].startIdx, secs[0].endIdx], [0, 0]);
  assert.equal(secs[0].words, 1000);
  assert.equal(secs[0].count, 1);
});

test("尾部残余不足下限：并入上一区间（含极端情况）", () => {
  const ps = [para(0, 150), para(1, 30)];
  const secs = planSections(ps);
  assert.equal(secs.length, 1);
  assert.deepEqual([secs[0].startIdx, secs[0].endIdx], [0, 1]);
  assert.equal(secs[0].words, 180);
  assert.equal(secs[0].count, 2);
});

test("短文章（总词数不足目标）：只有 1 个区间覆盖全文", () => {
  const ps = [para(0, 20), para(1, 20), para(2, 20)];
  const secs = planSections(ps);
  assert.equal(secs.length, 1);
  assert.deepEqual([secs[0].startIdx, secs[0].endIdx], [0, 2]);
  assert.equal(secs[0].words, 60);
});

test("段落数 < 2：不放标记", () => {
  assert.deepEqual(planSections([]), []);
  assert.deepEqual(planSections([para(0, 2000)]), []);
});

test("不变量：区间连续覆盖全部段落，标记永远落在段末", () => {
  const lengths = [12, 80, 200, 33, 150, 60, 90, 240, 20, 300, 45, 70, 110];
  const ps = lengths.map((w, i) => para(i, w));
  const secs = planSections(ps);

  let cursor = 0;
  for (const s of secs) {
    assert.equal(s.startIdx, ps[cursor].idx, "区间必须无缝衔接上一区间");
    const covered = ps.filter((p) => p.idx >= s.startIdx && p.idx <= s.endIdx);
    assert.equal(covered.length, s.count, "区间覆盖的段落数必须与 count 一致");
    assert.equal(s.words, covered.reduce((n, p) => n + countWords(p.content), 0));
    assert.ok(
      ps.some((p) => p.idx === s.endIdx),
      `标记必须落在真实存在的段落末尾：${s.endIdx}`,
    );
    cursor += s.count;
  }
  assert.equal(cursor, ps.length, "最后一个区间必须覆盖到最后一段");

  // 除最后一个区间外，每个区间都达到目标词数（尾部合并时可能略超）
  for (const s of secs.slice(0, -1)) {
    assert.ok(s.words >= SECTION_TARGET_WORDS, `区间应达到 ${SECTION_TARGET_WORDS} 词：${s.words}`);
  }
  assert.ok(
    secs[secs.length - 1].words >= SECTION_TAIL_MIN_WORDS,
    "最后一个区间不应低于尾部下限",
  );
});

test("可自定义目标词数与尾部下限", () => {
  const ps = Array.from({ length: 10 }, (_, i) => para(i, 50));
  const secs = planSections(ps, { targetWords: 300, tailMinWords: 120 });
  assert.equal(secs.length, 2);
  assert.deepEqual(
    secs.map((s) => [s.startIdx, s.endIdx]),
    [[0, 5], [6, 9]],
  );
});

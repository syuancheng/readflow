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
 *  - **绝不拆自然段**：标记只能落在段末
 *  - 文末残余太少时并入上一区间
 */

const para = (idx: number, words: number) => ({
  idx,
  content: Array.from({ length: words }, (_, i) => `w${i % 7}`).join(" "),
});

test("countWords：连字符与撇号算一个词，标点不计", () => {
  assert.equal(countWords("Hello, world!"), 2);
  assert.equal(countWords("don't stop well-known 2026"), 4);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   \n  "), 0);
});

test("每段 100 词 × 7 段：每 3 段一个区间，尾部并入上一区间", () => {
  const ps = Array.from({ length: 7 }, (_, i) => para(i, 100));
  const secs = planSections(ps);
  assert.equal(secs.length, 2, `区间数：${JSON.stringify(secs)}`);
  assert.deepEqual(
    secs.map((s) => [s.startIdx, s.endIdx]),
    [
      [0, 2],
      [3, 6],
    ],
    "第 7 段只有 100 词（< 尾部下限），必须并进上一区间而不是单独成区",
  );
  assert.equal(secs[1].words, 400);
});

test("每段 30 词 × 20 段：短线段落不会导致区间过小", () => {
  const ps = Array.from({ length: 20 }, (_, i) => para(i, 30));
  const secs = planSections(ps);
  assert.deepEqual(
    secs.map((s) => [s.startIdx, s.endIdx]),
    [
      [0, 9],
      [10, 19],
    ],
    "30 词一段需要累到第 10 段才够 300 词",
  );
  assert.ok(secs.every((s) => s.words >= SECTION_TARGET_WORDS));
});

test("单段超过目标词数：它自成一个区间，不拆分", () => {
  const ps = [para(0, 520), para(1, 40), para(2, 40), para(3, 40), para(4, 40), para(5, 40)];
  const secs = planSections(ps);
  assert.equal(secs[0].startIdx, 0);
  assert.equal(secs[0].endIdx, 0, "500 词的长段必须整段作为一个区间，标记落在段末");
  assert.equal(secs[0].words, 520);
  assert.deepEqual(
    secs[1] && [secs[1].startIdx, secs[1].endIdx],
    [1, 5],
    "后面 200 词不够 300，但超过尾部下限，单独成区",
  );
});

test("尾部残余不足下限：并入上一区间（含极端情况）", () => {
  const ps = [para(0, 500), para(1, 50)];
  const secs = planSections(ps);
  assert.equal(secs.length, 1);
  assert.deepEqual([secs[0].startIdx, secs[0].endIdx], [0, 1]);
  assert.equal(secs[0].words, 550);
  assert.equal(secs[0].count, 2);
});

test("短文章（总词数不足目标）：只有 1 个区间覆盖全文", () => {
  const ps = [para(0, 50), para(1, 50), para(2, 50)];
  const secs = planSections(ps);
  assert.equal(secs.length, 1);
  assert.deepEqual([secs[0].startIdx, secs[0].endIdx], [0, 2]);
  assert.equal(secs[0].words, 150);
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
  const secs = planSections(ps, { targetWords: 100, tailMinWords: 20 });
  assert.equal(secs.length, 5);
  assert.deepEqual(
    secs.map((s) => [s.startIdx, s.endIdx]),
    [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [8, 9],
    ],
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { addOption, CHOICE_MAX, CHOICE_MIN, removeOption, replaceBlock, retextSentence, setCorrect, setMulti } from "../../src/lib/cards/edit";
import type { Block } from "../../src/lib/cards/spec";
import { baseChoiceCard } from "./cards-fixtures";

type S = Extract<Block, { t: "sentence" }>;
type C = Extract<Block, { t: "choice" }>;
const sent = (text: string, start: number, end: number, as: "blank" | "highlight" = "blank"): S => ({
  t: "sentence", source: "paraphrase", text, mark: { start, end, as },
});
const choice = (n: number, correct: number[], multi = false): C => ({
  t: "choice", ...(multi ? { multi } : {}),
  options: Array.from({ length: n }, (_, i) => ({ text: `o${i}`, correct: correct.includes(i) })),
});

test("改写句改字：标记跟着被盖住的词走", () => {
  const out = retextSentence(sent("Joy was ephemeral.", 8, 17), "A very sad joy was ephemeral.");
  assert.equal(out.text, "A very sad joy was ephemeral.");
  assert.deepEqual([out.mark?.start, out.mark?.end], [19, 28]);
  assert.equal(out.text.slice(out.mark!.start, out.mark!.end), "ephemeral");
});

test("改写句改字：被盖住的词出现多次时选离原位置最近的", () => {
  const out = retextSentence(sent("aa bb aa", 6, 8), "aa bb cc aa");
  assert.equal(out.mark?.start, 9, "离原位置更近的是第二处");
});

test("改写句改字：被盖住的词没了 → 去掉标记；本来没有标记 → 只改文字", () => {
  const gone = retextSentence(sent("Joy was ephemeral.", 8, 17), "Joy was brief.");
  assert.equal(gone.mark, undefined);
  assert.equal(gone.text, "Joy was brief.");
  const plain = retextSentence({ t: "sentence", source: "paraphrase", text: "a" }, "b");
  assert.deepEqual(plain, { t: "sentence", source: "paraphrase", text: "b" });
  const empty = retextSentence(sent("abc", 2, 2), "x");
  assert.equal(empty.mark, undefined);
});

test("选择题：单选换正确答案只剩一个；多选可切换", () => {
  const single = setCorrect(choice(4, [0]), 2);
  assert.deepEqual(single.options.map((o) => o.correct), [false, false, true, false]);
  const multi = setCorrect(choice(4, [0], true), 2);
  assert.deepEqual(multi.options.map((o) => o.correct), [true, false, true, false]);
  assert.deepEqual(setCorrect(multi, 0).options.map((o) => o.correct), [false, false, true, false]);
});

test("选择题：选项最少 3 个、最多 5 个", () => {
  assert.equal(CHOICE_MIN, 3);
  assert.equal(CHOICE_MAX, 5);
  assert.equal(addOption(choice(5, [0])).options.length, 5);
  assert.equal(addOption(choice(4, [0])).options.length, 5);
  assert.deepEqual(addOption(choice(3, [0])).options[3], { text: "", correct: false });
  assert.equal(removeOption(choice(3, [0]), 1).options.length, 3);
  assert.equal(removeOption(choice(4, [0]), 1).options.length, 3);
});

test("删掉单选里唯一的正确答案 → 第一项补成正确；多选不补", () => {
  const out = removeOption(choice(4, [2]), 2);
  assert.equal(out.options.filter((o) => o.correct).length, 1);
  assert.equal(out.options[0].correct, true);
  const multi = removeOption(choice(4, [2, 3], true), 2);
  assert.equal(multi.options.filter((o) => o.correct).length, 1);
});

test("单选 ↔ 多选：切到单选只保留第一个正确答案；切到多选保留原样", () => {
  const toSingle = setMulti(choice(4, [1, 3], true), false);
  assert.equal(toSingle.multi, undefined);
  assert.deepEqual(toSingle.options.map((o) => o.correct), [false, true, false, false]);
  const noneCorrect = setMulti(choice(3, [], true), false);
  assert.equal(noneCorrect.options.filter((o) => o.correct).length, 1);
  const toMulti = setMulti(choice(3, [0]), true);
  assert.equal(toMulti.multi, true);
  assert.deepEqual(toMulti.options.map((o) => o.correct), [true, false, false]);
});

test("replaceBlock：只换指定区的指定块，不改原对象", () => {
  const spec = baseChoiceCard({ hints: [{ t: "text", text: "h" }] });
  const next: Block = { t: "instruction", text: "new" };
  const a = replaceBlock(spec, "front", 1, next);
  assert.equal((a.front[1] as { text: string }).text, "new");
  assert.equal((spec.front[1] as { text: string }).text, "ephemeral is closest in meaning to");
  assert.equal((replaceBlock(spec, "hints", 0, next).hints?.[0] as { text: string }).text, "new");
  assert.equal((replaceBlock(spec, "answer", 0, next).back.answer[0] as { text: string }).text, "new");
  assert.equal((replaceBlock(spec, "explanation", 0, next).back.explanation?.[0] as { text: string }).text, "new");
});

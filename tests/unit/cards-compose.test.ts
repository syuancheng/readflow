import assert from "node:assert/strict";
import test from "node:test";
import { checkComposition } from "../../src/lib/cards/compose";

const k = (...kinds: string[]) => kinds.map((kind) => ({ kind })) as { kind: string }[];

test("组卡检查：全部题型都是输出类，不需要重出也不标缺考试卡", () => {
  assert.deepEqual(checkComposition(k("back_translate"), false), { needsRedo: false, missingExam: false });
  const many = k("back_translate", "situation_say", "rephrase", "usage", "usage", "custom");
  assert.deepEqual(checkComposition(many, false), { needsRedo: false, missingExam: false });
  assert.deepEqual(checkComposition(k("situation_say"), true), { needsRedo: false, missingExam: false });
  assert.deepEqual(checkComposition([], false), { needsRedo: false, missingExam: false });
});

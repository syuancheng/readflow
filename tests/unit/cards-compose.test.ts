import assert from "node:assert/strict";
import test from "node:test";
import { checkComposition } from "../../src/lib/cards/compose";

const k = (...kinds: string[]) => kinds.map((kind) => ({ kind })) as { kind: never }[];

test("组卡检查：任何张数都不裁剪，有使用类卡就不用重出", () => {
  assert.deepEqual(checkComposition(k("back_translate"), false), { needsRedo: false, missingExam: false });
  const many = k("back_translate", "situation_say", "rephrase", "usage", "usage", "context_meaning");
  assert.equal(checkComposition(many, false).needsRedo, false);
});

test("组卡检查：一张使用类卡都没有 → 要求重出一次", () => {
  assert.equal(checkComposition(k("context_meaning", "word_completion"), false).needsRedo, true);
  assert.equal(checkComposition([], false).needsRedo, false);
});

test("组卡检查：有考试目标却没有认识类卡 → 只标记缺考试卡", () => {
  assert.equal(checkComposition(k("back_translate", "rephrase"), true).missingExam, true);
  assert.equal(checkComposition(k("back_translate", "context_meaning"), true).missingExam, false);
  assert.equal(checkComposition(k("back_translate"), false).missingExam, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { MAX_QUICK_QUESTIONS, MAX_QUICK_QUESTION_CHARS, checkAdd, normalizeQuestion } from "../../src/lib/quick-questions";

test("normalizeQuestion：去首尾空白，换行和连续空白压成一个空格", () => {
  assert.equal(normalizeQuestion("  这个词 \n 怎么记？  "), "这个词 怎么记？");
});

test("normalizeQuestion：不是字符串 / 空 / 超长 → null", () => {
  assert.equal(normalizeQuestion(undefined), null);
  assert.equal(normalizeQuestion(5), null);
  assert.equal(normalizeQuestion("   "), null);
  assert.equal(normalizeQuestion("字".repeat(MAX_QUICK_QUESTION_CHARS + 1)), null);
  assert.equal(normalizeQuestion("字".repeat(MAX_QUICK_QUESTION_CHARS))?.length, MAX_QUICK_QUESTION_CHARS);
});

test("checkAdd：合法的通过，并返回清理后的文字", () => {
  assert.deepEqual(checkAdd([], " 有什么近义词？ "), { ok: true, text: "有什么近义词？" });
});

test("checkAdd：重复（不分大小写）和超过上限被拒绝", () => {
  const dup = checkAdd(["What is a Synonym?"], "what is a synonym?");
  assert.equal(dup.ok, false);
  const full = checkAdd(Array.from({ length: MAX_QUICK_QUESTIONS }, (_, i) => `问题${i}`), "新问题");
  assert.equal(full.ok, false);
  assert.match((full as { reason: string }).reason, /最多存/);
});

test("checkAdd：空的给出长度提示", () => {
  const r = checkAdd([], "");
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /1～100/);
});

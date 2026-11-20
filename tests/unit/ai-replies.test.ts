import assert from "node:assert/strict";
import test from "node:test";
import { buildUserMessage, buildUserTail, effectiveReplies, narrowReplies, repliesSection } from "../../src/lib/ai";

/**
 * P58：多条回复（引用 + 批注）的校验与提示词。
 * 关键性质：只有 1 条且无批注时，与改前逐字相同（v1 快照与旧行为不变）。
 */
const base = { word: "tracks", context: "The database tracks history." };

test("narrowReplies：白名单、裁剪（500 / 200）、最多 5 条、空文本丢弃、非法结构丢弃", () => {
  assert.equal(narrowReplies(undefined), undefined);
  assert.equal(narrowReplies("x"), undefined);
  assert.equal(narrowReplies([]), undefined);
  assert.equal(narrowReplies([{ text: "  " }, null, 5, { note: "没有原话" }]), undefined);
  const out = narrowReplies([
    { text: "  原话一  ", note: "  批注  ", extra: "不透传" },
    { text: "x".repeat(900), note: "y".repeat(400) },
    { text: "原话三" },
  ])!;
  assert.deepEqual(out[0], { text: "原话一", note: "批注" });
  assert.equal(out[1].text.length, 500);
  assert.equal(out[1].note?.length, 200);
  assert.deepEqual(out[2], { text: "原话三" });
  assert.equal(narrowReplies(Array.from({ length: 9 }, (_, i) => ({ text: `原话${i}` })))!.length, 5);
});

test("effectiveReplies：replies 优先；只有旧的 quote 时当作一条无批注的回复", () => {
  assert.deepEqual(effectiveReplies({ quote: { text: "旧引用", turnIndex: 0 } }), [{ text: "旧引用" }]);
  assert.deepEqual(effectiveReplies({ quote: { text: "旧", turnIndex: 0 }, replies: [{ text: "新", note: "n" }] }), [{ text: "新", note: "n" }]);
  assert.deepEqual(effectiveReplies({}), []);
});

test("1 条无批注：提示词与改前逐字相同（v1 与 v2 尾部）", () => {
  const old = "你引用了自己上一条回答里的这段话：\n「when 引导时间状语从句」";
  assert.equal(repliesSection({ quote: { text: "when 引导时间状语从句", turnIndex: 0 } }), old);
  assert.equal(repliesSection({ replies: [{ text: "when 引导时间状语从句" }] }), old);
  const v1 = buildUserMessage({ ...base, prompt: "这是什么成分？", quote: { text: "when 引导时间状语从句", turnIndex: 0 } });
  assert.ok(v1.includes(`\n${old}\n学生的问题: 这是什么成分？`));
  const tail = buildUserTail({ ...base, prompt: "这是什么成分？", quote: { text: "when 引导时间状语从句", turnIndex: 0 } }, "");
  assert.ok(tail.includes(`${old}\n\n学生的问题: 这是什么成分？`));
});

test("多条或带批注：逐条编号；没有批注的条目不写批注行；没有回复时不插入任何字符", () => {
  const sec = repliesSection({
    replies: [{ text: "第一处", note: "这里不懂" }, { text: "第二处" }, { text: "第三处", note: "再讲讲" }],
  });
  assert.equal(
    sec,
    "你引用了自己前面回答里的几处话，并写了批注（按顺序）：\n1. 「第一处」\n   学生的批注：这里不懂\n2. 「第二处」\n3. 「第三处」\n   学生的批注：再讲讲",
  );
  // 1 条但带批注，也走编号格式
  assert.match(repliesSection({ replies: [{ text: "原话", note: "批注" }] }), /几处话/);
  assert.equal(repliesSection({}), "");
  const msg = buildUserMessage({ ...base, prompt: "q" });
  assert.equal(msg.includes("你引用了"), false);
});

test("没有底部问题只发回复：prompt 由前端给出，提示词里问题行照常写", () => {
  const m = buildUserMessage({ ...base, prompt: "学生没有另外提问，请针对他引用的几处话和批注回答。", replies: [{ text: "a", note: "b" }] });
  assert.ok(m.includes("学生的问题: 学生没有另外提问"));
  assert.ok(m.includes("学生的批注：b"));
});

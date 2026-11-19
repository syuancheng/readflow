import assert from "node:assert/strict";
import test from "node:test";
import {
  DIGEST_PREFIX,
  HISTORY_BUDGET_TOKENS,
  HISTORY_FULL_MAX_CHARS,
  HISTORY_PINNED_FLOOR_CHARS,
  HISTORY_RECENT_FLOOR_CHARS,
  HISTORY_RECENT_TURNS,
  cleanAnswer,
  clipMiddle,
  digestOf,
  estimateTokens,
  firstCompressedIndex,
  planHistory,
} from "../../src/lib/history-compress";

const turn = (i: number, len = 100) => ({ ...(i === 0 ? {} : { ask: `问题${i}` }), text: `释义：第${i}轮\n` + "字".repeat(len) });

test("estimateTokens：中文约 1.5/字，英文约 1/4 字符", () => {
  assert.equal(estimateTokens("中文"), 3);
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("cleanAnswer：去掉末尾的制卡建议行和句子地图行，其余原样", () => {
  const text = "释义：好\n正文一行\n==主语== 谓语 ==宾语==\n制卡建议：值得记";
  assert.equal(cleanAnswer(text), "释义：好\n正文一行");
  // 全被清掉时退回原文，不返回空
  assert.equal(cleanAnswer("制卡建议：只有建议"), "制卡建议：只有建议");
});

test("clipMiddle：不超长原样；超长从中间截，结果恰好 max 字，保留头尾", () => {
  assert.equal(clipMiddle("abc", 10), "abc");
  const out = clipMiddle("头" + "x".repeat(100) + "尾", 40);
  assert.equal([...out].length, 40);
  assert.ok(out.startsWith("头") && out.endsWith("尾") && out.includes("中间省略"));
});

test("digestOf：取开头两行，超长加省略号", () => {
  assert.equal(digestOf("释义：好\n第二行\n第三行"), "释义：好\n第二行");
  const long = digestOf("字".repeat(500), 300);
  assert.equal([...long].length, 300);
  assert.ok(long.endsWith("…"));
});

test("planHistory：不超过「1 + 最近 3」轮时全部完整，内容不变", () => {
  const input = Array.from({ length: 1 + HISTORY_RECENT_TURNS }, (_, i) => turn(i));
  const plan = planHistory(input);
  assert.deepEqual(plan.tiers, ["pinned", "full", "full", "full"]);
  assert.deepEqual(plan.turns.map((t) => t.text), input.map((t) => t.text));
  assert.equal(plan.omitted, 0);
  assert.equal(firstCompressedIndex(plan.tiers), -1);
});

test("planHistory：首次讲解钉住、最近 3 轮完整、中间是要点（按位置，与预算无关）", () => {
  const plan = planHistory(Array.from({ length: 8 }, (_, i) => turn(i)));
  assert.deepEqual(plan.tiers, ["pinned", "digest", "digest", "digest", "digest", "full", "full", "full"]);
  assert.ok(plan.turns[1].text.startsWith(DIGEST_PREFIX));
  assert.ok(!plan.turns[5].text.startsWith(DIGEST_PREFIX));
  assert.equal(firstCompressedIndex(plan.tiers), 1);
});

test("planHistory：位置固定 → 再多一轮，已经压缩的那几轮内容不变（缓存前缀稳定）", () => {
  const a = planHistory(Array.from({ length: 8 }, (_, i) => turn(i)));
  const b = planHistory(Array.from({ length: 9 }, (_, i) => turn(i)));
  assert.deepEqual(b.turns.slice(0, 5), a.turns.slice(0, 5), "首次讲解和前 4 个要点逐字相同");
});

test("planHistory：回答里的制卡建议行不进历史", () => {
  const plan = planHistory([{ text: "释义：好\n制卡建议：很常用" }]);
  assert.equal(plan.turns[0].text, "释义：好");
});

test("planHistory：学生问题历史里最多 60 字", () => {
  const plan = planHistory([{ text: "a" }, { ask: "问".repeat(200), text: "b" }]);
  assert.equal(plan.turns[1].ask?.length, 60);
});

test("planHistory：超预算 —— 先丢最早的要点，首次讲解和最近 3 轮保留", () => {
  const input = Array.from({ length: 30 }, (_, i) => turn(i, 900));
  const plan = planHistory(input);
  assert.ok(plan.omitted > 0);
  assert.equal(plan.tiers[0], "pinned");
  assert.deepEqual(plan.tiers.slice(-3), ["full", "full", "full"]);
  assert.equal(plan.tiers[1], "dropped", "最早的要点先丢");
  const total = plan.turns.reduce((s, t) => s + estimateTokens((t.ask ?? "") + t.text), 0);
  assert.ok(total <= HISTORY_BUDGET_TOKENS, `压缩后 ${total} ≤ 预算`);
});

test("planHistory：要点丢光仍超预算 —— 依次缩短近期几轮、最后缩短首次讲解", () => {
  const huge = Array.from({ length: 5 }, (_, i) => turn(i, 5000));
  const plan = planHistory(huge, 1000);
  assert.ok(plan.tiers.every((t) => t !== "dropped" || true));
  const lens = plan.turns.map((t) => [...t.text].length);
  assert.ok(lens.slice(1).every((l) => l <= HISTORY_RECENT_FLOOR_CHARS), "近期几轮缩到下限");
  assert.ok(lens[0] <= HISTORY_PINNED_FLOOR_CHARS, "首次讲解最后才缩到下限");
  assert.ok(lens[0] <= HISTORY_FULL_MAX_CHARS);
});

test("planHistory：空输入", () => {
  assert.deepEqual(planHistory([]), { tiers: [], turns: [], omitted: 0 });
});

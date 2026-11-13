import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_MAX_CHARS,
  NOTE_MIN_NEW_LOOKUPS,
  NOTE_MIN_INTERVAL_MS,
  shouldUpdateNote,
  buildNotePrompt,
  validateNote,
} from "../../src/lib/learner/note";
import { EMPTY_BEHAVIOR_STATS, type BehaviorStats } from "../../src/lib/learner/types";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DAY = 24 * 3600 * 1000;
const stats = (over: Partial<BehaviorStats> = {}): BehaviorStats => ({ ...EMPTY_BEHAVIOR_STATS, ...over });

test("阈值常量：25 次查词 + 24 小时 + 300 字（PRD F3）", () => {
  assert.equal(NOTE_MIN_NEW_LOOKUPS, 25);
  assert.equal(NOTE_MIN_INTERVAL_MS, 24 * 3600 * 1000);
  assert.equal(NOTE_MAX_CHARS, 300);
});

test("shouldUpdateNote：新增查词够 25 且满 24 小时才更新", () => {
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 100, cursor: 75, updatedAt: NOW - DAY, now: NOW }),
    true,
  );
});

test("shouldUpdateNote：新增查词够 25 但不满 24 小时不更新", () => {
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 100, cursor: 75, updatedAt: NOW - DAY + 1, now: NOW }),
    false,
  );
});

test("shouldUpdateNote：满 24 小时但新增查词只有 24 次不更新", () => {
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 99, cursor: 75, updatedAt: NOW - DAY, now: NOW }),
    false,
  );
});

test("shouldUpdateNote：两个条件都不满足不更新", () => {
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 80, cursor: 75, updatedAt: NOW - 1000, now: NOW }),
    false,
  );
});

test("shouldUpdateNote：从来没有笔记时只看 25 次，不看 24 小时", () => {
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 25, cursor: 0, updatedAt: null, now: NOW }),
    true,
  );
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 24, cursor: 0, updatedAt: null, now: NOW }),
    false,
  );
});

test("shouldUpdateNote：25 次与 24 小时都是包含边界的", () => {
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 25, cursor: 0, updatedAt: NOW - DAY, now: NOW }),
    true,
    "正好 25 次、正好 24 小时应通过",
  );
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 26, cursor: 1, updatedAt: NOW - DAY - 1, now: NOW }),
    true,
  );
});

test("shouldUpdateNote：清空记忆后游标归零，重新累计", () => {
  // 清空后 cursor=0、updatedAt=null，旧的 40 次事件不能算进来
  assert.equal(shouldUpdateNote({ lookupsTotal: 0, cursor: 0, updatedAt: null, now: NOW }), false);
  assert.equal(shouldUpdateNote({ lookupsTotal: 25, cursor: 0, updatedAt: null, now: NOW }), true);
});

test("validateNote：合法的纯中文笔记原样通过", () => {
  const r = validateNote("词汇量约 6000，技术词汇强于日常词汇；常在长定语从句上卡住，偏好简短解释，很少追问例句。");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.note.startsWith("词汇量约"), true);
});

test("validateNote：空内容被拒绝", () => {
  assert.deepEqual(validateNote("   \n  "), { ok: false, reason: "笔记为空" });
});

test("validateNote：超过 300 字时截到最后一个句号", () => {
  const first = "学生读技术文档较多，偏好简短解释。".repeat(20); // 远长于 300
  const tail = "补充说明没有句号结尾";
  const raw = `${first}${tail}`;
  assert.ok(raw.length > NOTE_MAX_CHARS);
  const r = validateNote(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.note.length <= NOTE_MAX_CHARS);
    assert.ok(r.note.endsWith("。"), "截断后必须以句号结尾");
  }
});

test("validateNote：超过 300 字且句号落在 300 字之后时拒绝", () => {
  const raw = `${"这是一段很长的中文观察文字".repeat(30)}。最后才出现句号。`;
  assert.ok(raw.length > NOTE_MAX_CHARS);
  const r = validateNote(raw);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /超过 300 字/);
});

test("validateNote：超过 300 字且完全没有句号时拒绝", () => {
  const r = validateNote("这是一段没有句号的长中文观察".repeat(30));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /超过 300 字/);
});

test("validateNote：恰好 300 字通过，301 字走截断/拒绝分支", () => {
  const exactly = "中".repeat(NOTE_MAX_CHARS);
  assert.equal(validateNote(exactly).ok, true);
  const over = `${"中".repeat(NOTE_MAX_CHARS)}。`;
  const r = validateNote(over);
  // 句号在末尾，截完仍是 301 字 → 必须拒绝
  assert.equal(r.ok, false);
});

test("validateNote：6 个以内英文单词通过，7 个被拒绝", () => {
  assert.equal(validateNote("偏好 CEFR B2 一类的技术说明。").ok, true);
  const r = validateNote("one two three four five six seven 都是英文词。");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /英文单词/);
});

test("validateNote：评价人格的用词一律拒绝（懒 / 笨 / 差劲）", () => {
  for (const w of ["懒", "笨", "差劲", "愚蠢", "迟钝"]) {
    const r = validateNote(`这个学生有点${w}，讲解要更细。`);
    assert.equal(r.ok, false, `「${w}」应被拒绝`);
    if (!r.ok) assert.match(r.reason, /评价性用词/);
  }
});

test("validateNote：Markdown 标记一律拒绝（分点 / 加粗 / 代码 / 链接）", () => {
  for (const raw of [
    "**词汇量**约 6000。",
    "- 常在长句上卡住\n- 偏好简短解释。",
    "1. 第一点\n2. 第二点",
    "```中文笔记```",
    "# 标题\n正文",
    "参考[链接](http://example.com)里的说明。",
  ]) {
    const r = validateNote(raw);
    assert.equal(r.ok, false, `${JSON.stringify(raw.slice(0, 20))} 应被拒绝`);
    if (!r.ok) assert.match(r.reason, /Markdown/);
  }
});

test("validateNote(user)：用户手改只查长度与 Markdown，不限制英文词和自我评价", () => {
  // 「不列具体单词 / 不评价人格」是给模型的约束，用户自己写的内容不该被这两条挡住
  assert.equal(validateNote("我常查 artifact 和 deploy 这类词，自己有点懒。", "user").ok, true);
  const md = validateNote("**我自己写的笔记**", "user");
  assert.equal(md.ok, false);
  if (!md.ok) assert.match(md.reason, /Markdown/);
});

test("validateNote(user)：超过 300 字直接拒绝，不擅自截断用户输入", () => {
  const raw = `${"中文观察。".repeat(70)}`; // 350 字
  assert.ok(raw.length > NOTE_MAX_CHARS);
  const r = validateNote(raw, "user");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /超过 300 字/);
});

test("buildNotePrompt：系统提示词写明不要列具体单词、以统计为准、改写不追加", () => {
  const { system } = buildNotePrompt({ oldNote: null, userEdited: false, stats: stats(), recent: [] });
  assert.match(system, /不要列出具体单词/);
  assert.match(system, /以统计数据为准/);
  assert.match(system, /改写（不是追加）/);
  assert.match(system, /不要评价学生的人格/);
  assert.match(system, /不分点/);
  assert.match(system, /300 字/);
});

test("buildNotePrompt：统计数据进入 user 消息，具体英文词不进入", () => {
  const { user } = buildNotePrompt({
    oldNote: null,
    userEdited: false,
    stats: stats({
      lookups: 42,
      cefr: "B2",
      vocab: 6000,
      difficulties: ["long_sentence"],
      feedback: { shallow: 1, right: 2, deep: 3 },
    }),
    recent: [{ word: "artifact", askKind: "structure", feedback: "deep", repeatCount: 3 }],
  });
  assert.match(user, /最近 42 次查词/);
  assert.match(user, /B2/);
  assert.match(user, /长句结构/);
  assert.match(user, /太深 3 次/);
  assert.match(user, /短语|单词/);
  assert.ok(!user.includes("artifact"), "不能把具体英文单词写进提示词");
});

test("buildNotePrompt：用户改过笔记时标出重要性并保留原文", () => {
  const old = "学生自己写的观察：偏好一句话讲完。";
  const { user, system } = buildNotePrompt({
    oldNote: old,
    userEdited: true,
    stats: stats(),
    recent: [],
  });
  assert.ok(user.includes(old));
  assert.match(user, /重要参考保留/);
  assert.match(system, /重要参考/);
});

test("buildNotePrompt：AI 自己写的旧笔记不带「重要参考」提示，也不覆盖", () => {
  const old = "AI 上一版写的观察：偏好简短解释。";
  const { user } = buildNotePrompt({
    oldNote: old,
    userEdited: false,
    stats: stats(),
    recent: [],
  });
  assert.ok(user.includes(old));
  assert.ok(!user.includes("重要参考保留"), "只有用户改过的笔记才标注要保留");
});

test("buildNotePrompt：未知问法 / 反馈 / 难点安全降级，追问率与 20 条上限都生效", () => {
  const { user } = buildNotePrompt({
    oldNote: null,
    userEdited: false,
    stats: stats({
      lookups: 60,
      followupRate: 0.42,
      difficulties: ["long_sentence", "mystery"] as unknown as BehaviorStats["difficulties"],
      feedback: { shallow: 0, right: 0, deep: 0 },
    }),
    recent: [
      { word: "alpha beta", askKind: "unknown_kind", feedback: "unknown_feedback", repeatCount: 1 },
      ...Array.from({ length: 25 }, (_, i) => ({ word: `w${i}` })),
    ],
  });
  assert.match(user, /unknown_kind/, "未知问法原样保留，不抛错");
  assert.match(user, /unknown_feedback/, "未知反馈原样保留");
  assert.match(user, /mystery/, "未知难点原样保留");
  assert.match(user, /42%/, "追问率换算成百分比");
  assert.match(user, /短语/, "带空格的选区判为短语");
  assert.ok(!user.includes("同句第 1 次"), "第 1 次不输出重复次数");
  const bullets = user.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(bullets.length <= 20, `摘要最多 20 条，实际 ${bullets.length}`);
});

test("buildNotePrompt：没有旧笔记时提示这是第一份", () => {
  const { user } = buildNotePrompt({ oldNote: null, userEdited: false, stats: stats(), recent: [] });
  assert.match(user, /第一份/);
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P34 F2：recentFeedbackFor 从数据库按评价分组各取最新一条。
 * 用 /tmp 下的隔离库直连 learner-store，不碰 data/readflow.db。
 */
const DB = path.join(os.tmpdir(), `rf-feedback-store-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  const f = DB + suffix;
  if (fs.existsSync(f)) fs.writeFileSync(f, "");
}
process.env.DB_PATH = DB;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("../../src/lib/learner-store") as typeof import("../../src/lib/learner-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");
const db = new Database(DB);

const NOW = Date.UTC(2026, 10, 18, 1, 0, 0);
const DAY = 24 * 3600 * 1000;

function add(opts: {
  id: string;
  user: string;
  feedback: string | null;
  feedbackAt?: number;
  createdAt?: number;
  askKind?: string;
  askLabel?: string | null;
  isPhrase?: boolean;
  answer?: string | null;
}): void {
  db.prepare(
    `INSERT INTO explain_events
       (id, user_id, kind, via, word, ask_kind, is_phrase, feedback, feedback_at, created_at)
     VALUES (?, ?, 'explain', 'reader', 'artifact', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id, opts.user, opts.askKind ?? "auto", opts.isPhrase ? 1 : 0,
    opts.feedback, opts.feedbackAt ?? NOW - 1000, opts.createdAt ?? NOW - 1000,
  );
  if (opts.answer) {
    db.prepare(
      `INSERT INTO explain_answers (event_id, user_id, context_id, ask_label, answer_text, created_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    ).run(opts.id, opts.user, opts.askLabel ?? null, opts.answer, opts.createdAt ?? NOW - 1000);
  }
}

db.prepare("INSERT INTO learner_profiles (user_id, memory_reset_at, updated_at) VALUES ('A', ?, ?)").run(NOW - 10 * DAY, NOW);

test("三档各取最新一条：旧的回答原文不会被误用，count 统计全部反馈", () => {
  add({ id: "d-old", user: "A", feedback: "deep", feedbackAt: NOW - 1000, answer: "释义：x\n这里讲得很长。" });
  add({ id: "d-new", user: "A", feedback: "deep", feedbackAt: NOW - 500, answer: "释义：通用的\n==主语：The design== is generic.\n这里讲得很长。" });
  add({ id: "r", user: "A", feedback: "right", feedbackAt: NOW - 2000, askKind: "default", isPhrase: true, answer: "释义：受益于\n整句大意：一句话概括这里的意思。" });
  add({ id: "s", user: "A", feedback: "shallow", feedbackAt: NOW - 3000, askKind: "custom", askLabel: "为什么不按字面理解", answer: "释义：x" });
  add({ id: "odd", user: "A", feedback: "odd", feedbackAt: NOW - 100 });
  add({ id: "other", user: "B", feedback: "deep", feedbackAt: NOW - 50 });
  add({ id: "expired", user: "A", feedback: "right", feedbackAt: NOW - 40 * DAY, createdAt: NOW - 40 * DAY });
  add({ id: "before-reset", user: "A", feedback: "right", feedbackAt: NOW - 100, createdAt: NOW - 11 * DAY });

  const got = store.recentFeedbackFor("A", NOW);
  assert.deepEqual(got.lines, [
    "单词，自动讲解：约 10 字，画了句子地图 → 太深",
    "短语，这个词在句里的意思：约 10 字，有整句大意 → 刚好",
    "单词，为什么不按字面理解 → 太浅",
  ]);
  assert.equal(got.count, 5, "只算本人、30 天内、清空记忆之后的反馈；未知档也算一次");
});

test("某一档特别多时不会把另外两档挤出候选池", () => {
  db.prepare("INSERT INTO learner_profiles (user_id, memory_reset_at, updated_at) VALUES ('C', 0, ?)").run(NOW);
  for (let i = 0; i < 60; i++) {
    add({ id: `many-${i}`, user: "C", feedback: "deep", feedbackAt: NOW - i - 1 });
  }
  add({ id: "late-right", user: "C", feedback: "right", feedbackAt: NOW - 5000 });

  const got = store.recentFeedbackFor("C", NOW);
  assert.equal(got.lines.length, 2, "深的 60 条只出 1 行，旧的「刚好」仍在");
  assert.equal(got.lines[1], "单词，自动讲解 → 刚好");
  assert.equal(got.count, 61);
});

test("反馈原因：写入反馈时保存，档案行里带原因；未知原因忽略", () => {
  db.prepare("INSERT INTO learner_profiles (user_id, memory_reset_at, updated_at) VALUES ('D', 0, ?)").run(NOW);
  add({ id: "d-reason", user: "D", feedback: "deep", feedbackAt: NOW - 10 });
  assert.equal(store.setFeedback("D", "d-reason", "deep", "gave_answer"), true);
  assert.equal(
    (db.prepare("SELECT feedback_reason FROM explain_events WHERE id = 'd-reason'").get() as { feedback_reason: string }).feedback_reason,
    "gave_answer",
  );
  const got = store.recentFeedbackFor("D", NOW);
  assert.equal(got.lines[0], "单词，自动讲解：原因：直接给了答案或整句翻译 → 太深");

  store.setFeedback("D", "d-reason", "deep", "bogus");
  assert.equal(
    (db.prepare("SELECT feedback_reason FROM explain_events WHERE id = 'd-reason'").get() as { feedback_reason: string | null }).feedback_reason,
    null,
  );
});

test("教学规则与水平覆盖：落库、读取、非法值不进库", () => {
  const rules = store.saveTeachingRules("D", { can: ["只答选中的词"], cannot: ["不要整句翻译"] });
  assert.deepEqual(rules, { can: ["只答选中的词"], cannot: ["不要整句翻译"] });
  assert.deepEqual(store.teachingRulesFor("D"), rules);
  assert.deepEqual(store.saveLevelOverride("D", { cefr: "A2", vocab: 1000 }), { cefr: "A2", vocab: 1000 });

  const profile = store.getProfileForPrompt("D");
  assert.deepEqual(profile.rules, rules);
  assert.deepEqual(profile.levelOverride, { cefr: "A2", vocab: 1000 });
  assert.equal(profile.level?.cefr, "A2");
  assert.equal(profile.level?.vocab, 1000);

  assert.deepEqual(store.saveLevelOverride("D", { cefr: "Z9", vocab: -1 }), { cefr: null, vocab: null });
});

test("笔记历史：手改与 AI 整理都留版本，回滚产生新版本，清空记忆删历史", () => {
  store.saveNote("D", "AI 观察：常卡在长句。", "nightly");
  store.editNote("D", "学生手改：先讲释义。");
  let history = store.noteHistoryFor("D");
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((h) => h.kind), ["user", "nightly"]);
  const target = history[1].id;

  const restored = store.restoreNote("D", target);
  assert.equal(restored, "AI 观察：常卡在长句。");
  history = store.noteHistoryFor("D");
  assert.equal(history.length, 3);
  assert.equal(history[0].kind, "restore");
  assert.equal(store.restoreNote("D", "not-exist"), null);

  store.resetMemory("D");
  assert.equal(store.noteHistoryFor("D").length, 0);
  assert.equal(store.getLearner("D").note, null);
});

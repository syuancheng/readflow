import assert from "node:assert/strict";
import test from "node:test";
import { ensureAnswers } from "../../src/db/ensure-answers";

// 真实 SQLite 内存库；不碰 data/readflow.db
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");
type Db = import("better-sqlite3").Database;

function baseDb(): Db {
  const db = new Database(":memory:") as Db;
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE explain_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE learner_profiles (user_id TEXT PRIMARY KEY, note TEXT, updated_at INTEGER NOT NULL);
  `);
  return db;
}
const cols = (db: Db, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

test("P34 建表：explain_answers 六列 + learner_profiles.note_update_kind", () => {
  const db = baseDb();
  ensureAnswers(db);
  assert.deepEqual(cols(db, "explain_answers"), ["event_id", "user_id", "context_id", "ask_label", "answer_text", "created_at"]);
  assert.ok(cols(db, "learner_profiles").includes("note_update_kind"));
  db.close();
});

test("重复执行不报错、不改数据", () => {
  const db = baseDb();
  ensureAnswers(db);
  db.exec("INSERT INTO explain_events VALUES ('e1', 'u', 'explain', 1); INSERT INTO explain_answers VALUES ('e1', 'u', 'c1', NULL, '释义：x', 1);");
  ensureAnswers(db);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM explain_answers").get() as { n: number }).n, 1);
  db.close();
});

test("讲解记录删除时，回答原文随外键一起删除", () => {
  const db = baseDb();
  ensureAnswers(db);
  db.exec("INSERT INTO explain_events VALUES ('e1', 'u', 'explain', 1); INSERT INTO explain_answers VALUES ('e1', 'u', NULL, NULL, 'x', 1);");
  db.exec("DELETE FROM explain_events WHERE id = 'e1'");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM explain_answers").get() as { n: number }).n, 0);
  db.close();
});

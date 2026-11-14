import assert from "node:assert/strict";
import test from "node:test";
import { ensureDailyUsage } from "../../src/db/ensure-usage";

// 用真实 SQLite 内存库模拟老库；不碰 data/readflow.db
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");

type Db = import("better-sqlite3").Database;

const tables = (db: Db) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const usage = (db: Db) =>
  db.prepare("SELECT user_id, day, kind, count FROM daily_usage ORDER BY user_id, day, kind").all();

/** 改动前的老库：两张计数表 + 两张空的语音表 */
function oldDb(): Db {
  const db = new Database(":memory:") as Db;
  db.exec(`
    CREATE TABLE ai_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
    CREATE TABLE card_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
    CREATE TABLE tts_audio (hash TEXT PRIMARY KEY, text TEXT NOT NULL, voice TEXT NOT NULL, speed TEXT NOT NULL, file_path TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE markji_media (user_id TEXT NOT NULL, audio_hash TEXT NOT NULL, file_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, audio_hash));
    INSERT INTO ai_usage VALUES ('u1', '2026-11-13', 30), ('u1', '2026-11-14', 7), ('u2', '2026-11-14', 2);
    INSERT INTO card_usage VALUES ('u1', '2026-11-14', 5);
  `);
  return db;
}

test("老库迁移：两张计数表的每一行原样搬进 daily_usage（按 kind 区分），旧表删除", () => {
  const db = oldDb();
  ensureDailyUsage(db);
  assert.deepEqual(usage(db), [
    { user_id: "u1", day: "2026-11-13", kind: "ai", count: 30 },
    { user_id: "u1", day: "2026-11-14", kind: "ai", count: 7 },
    { user_id: "u1", day: "2026-11-14", kind: "card", count: 5 },
    { user_id: "u2", day: "2026-11-14", kind: "ai", count: 2 },
  ]);
  const t = tables(db);
  for (const gone of ["ai_usage", "card_usage", "tts_audio", "markji_media"]) assert.ok(!t.includes(gone), gone);
  assert.ok(t.includes("daily_usage"));
  db.close();
});

test("重复执行不改变任何数据（第二次启动什么也不做）", () => {
  const db = oldDb();
  ensureDailyUsage(db);
  const once = usage(db);
  ensureDailyUsage(db);
  assert.deepEqual(usage(db), once);
  db.close();
});

test("全新空库：只建 daily_usage，不报错", () => {
  const db = new Database(":memory:") as Db;
  ensureDailyUsage(db);
  assert.deepEqual(tables(db), ["daily_usage"]);
  db.close();
});

test("语音表里万一有数据：保留不删；计数表照常迁移", () => {
  const db = oldDb();
  db.exec("INSERT INTO tts_audio VALUES ('h', 't', 'v', '1', 'data/tts/h.mp3', 10, 1)");
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    ensureDailyUsage(db);
  } finally {
    console.warn = warn;
  }
  const t = tables(db);
  assert.ok(t.includes("tts_audio"), "有数据的语音表保留");
  assert.ok(!t.includes("markji_media"), "空的照常删");
  assert.ok(!t.includes("ai_usage") && !t.includes("card_usage"));
  assert.ok(warned.some((m) => m.includes("tts_audio")));
  db.close();
});

test("新表里已有同一天的计数时取较大值（宁可少给免费次数，不多给）", () => {
  const db = oldDb();
  db.exec(`CREATE TABLE daily_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('ai', 'card')), count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day, kind));
           INSERT INTO daily_usage VALUES ('u1', '2026-11-14', 'ai', 9), ('u2', '2026-11-14', 'ai', 1);`);
  ensureDailyUsage(db);
  const rows = usage(db) as { user_id: string; day: string; kind: string; count: number }[];
  assert.equal(rows.find((r) => r.user_id === "u1" && r.day === "2026-11-14" && r.kind === "ai")?.count, 9);
  assert.equal(rows.find((r) => r.user_id === "u2" && r.kind === "ai")?.count, 2);
  db.close();
});

test("kind 只能是 ai 或 card", () => {
  const db = new Database(":memory:") as Db;
  ensureDailyUsage(db);
  assert.throws(() => db.prepare("INSERT INTO daily_usage VALUES ('u', '2026-11-14', 'other', 1)").run());
  db.close();
});

test("迁移中途出错整体回滚：旧表和数据都还在", () => {
  const db = oldDb();
  // 让 card_usage 的迁移撞上 CHECK 之外的错误：把它改名成一张缺 day 列的表
  db.exec("DROP TABLE card_usage; CREATE TABLE card_usage (user_id TEXT NOT NULL, count INTEGER)");
  db.exec("INSERT INTO card_usage VALUES ('u1', 1)");
  assert.throws(() => ensureDailyUsage(db));
  const t = tables(db);
  assert.ok(t.includes("ai_usage") && t.includes("card_usage"), "出错后旧表不能丢");
  assert.ok(!t.includes("daily_usage"), "新表也随事务回滚");
  db.close();
});

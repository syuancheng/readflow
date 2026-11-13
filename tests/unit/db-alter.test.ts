import assert from "node:assert/strict";
import test from "node:test";
import { addColumnIfMissing } from "../../src/db/alter";

// 只有这个测试用真实 SQLite 内存库；不碰 data/readflow.db
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");

const cols = (db: { prepare: (s: string) => { all: () => { name: string }[] } }) =>
  db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);

test("加列成功：列真的出现在表里", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE users (id TEXT)");
  addColumnIfMissing(db, "ALTER TABLE users ADD COLUMN phone TEXT", "users", "phone");
  assert.ok(cols(db).includes("phone"));
  db.close();
});

test("两个进程同时加同一列：duplicate column 后复查列存在，当作成功", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE users (id TEXT)");
  addColumnIfMissing(db, "ALTER TABLE users ADD COLUMN phone TEXT", "users", "phone");
  // 模拟第二个 worker 拿到旧的 PRAGMA 结果，仍然执行 ALTER
  assert.doesNotThrow(() =>
    addColumnIfMissing(db, "ALTER TABLE users ADD COLUMN phone TEXT", "users", "phone"),
  );
  assert.equal(cols(db).filter((c) => c === "phone").length, 1, "不能加出两个 phone 列");
  db.close();
});

test("duplicate column 但复查的列并不存在时，不能误当作成功", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE users (id TEXT, phone TEXT)");
  assert.throws(() =>
    addColumnIfMissing(db, "ALTER TABLE users ADD COLUMN phone TEXT", "users", "other_column"),
  );
  db.close();
});

test("其它错误（表不存在）照常抛出，不被吞掉", () => {
  const db = new Database(":memory:");
  assert.throws(() =>
    addColumnIfMissing(db, "ALTER TABLE nope ADD COLUMN phone TEXT", "nope", "phone"),
  );
  db.close();
});

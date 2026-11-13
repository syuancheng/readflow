import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P32 阶段二 D：contextId / textId 来自客户端，写讲解事件前必须校验归属。
 * 这里用 /tmp 下的隔离库直连 learner-store（不走 next start），不碰 data/readflow.db。
 * node --test 每个文件独立进程，DB_PATH 只影响本文件。
 */
const DB = path.join(os.tmpdir(), `rf-learner-refs-${process.pid}.db`);
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
db.exec(`
  CREATE TABLE IF NOT EXISTS user_words (id TEXT PRIMARY KEY, user_id TEXT);
  CREATE TABLE IF NOT EXISTS contexts (id TEXT PRIMARY KEY, user_word_id TEXT);
  CREATE TABLE IF NOT EXISTS texts (id TEXT PRIMARY KEY, user_id TEXT, cefr_level TEXT);
`);
db.prepare("INSERT INTO user_words (id, user_id) VALUES ('wA', 'A')").run();
db.prepare("INSERT INTO user_words (id, user_id) VALUES ('wB', 'B')").run();
db.prepare("INSERT INTO contexts (id, user_word_id) VALUES ('cA', 'wA')").run();
db.prepare("INSERT INTO contexts (id, user_word_id) VALUES ('cB', 'wB')").run();
db.prepare("INSERT INTO texts (id, user_id, cefr_level) VALUES ('tA', 'A', 'B2')").run();
db.prepare("INSERT INTO texts (id, user_id, cefr_level) VALUES ('tB', 'B', 'C1')").run();

const rowOf = (id: string) =>
  db.prepare("SELECT text_id, context_id, text_cefr FROM explain_events WHERE id = ?").get(id) as {
    text_id: string | null;
    context_id: string | null;
    text_cefr: string | null;
  };

test("本人的 contextId / textId 原样写入，顺便带上文章难度", () => {
  const id = store.logExplain({
    userId: "A", askKind: "auto", via: "reader", word: "artifact",
    contextId: "cA", textId: "tA",
  });
  assert.deepEqual(rowOf(id), { text_id: "tA", context_id: "cA", text_cefr: "B2" });
});

test("别人的 contextId / textId 一律存 null，不能串到别人的画像里", () => {
  const id = store.logExplain({
    userId: "A", askKind: "auto", via: "reader", word: "artifact",
    contextId: "cB", textId: "tB",
  });
  assert.deepEqual(rowOf(id), { text_id: null, context_id: null, text_cefr: null });
});

test("不存在的 id 也存 null", () => {
  const id = store.logExplain({
    userId: "A", askKind: "auto", via: "reader", word: "artifact",
    contextId: "nope", textId: "nope",
  });
  assert.deepEqual(rowOf(id), { text_id: null, context_id: null, text_cefr: null });
});

test("查词事件同样校验归属", () => {
  const id = store.logLookup({
    userId: "A", word: "artifact", lemma: "artifact", via: "reader",
    contextId: "cB", textId: "tB",
  });
  assert.deepEqual(rowOf(id), { text_id: null, context_id: null, text_cefr: null });
});

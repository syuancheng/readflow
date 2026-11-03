import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "readflow.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

/**
 * Next.js dev 的热重载会反复重新求值模块，若每次都 new 一个连接，
 * 旧连接不释放会在 WAL 模式下撞上 "disk I/O error"。
 * 挂到 globalThis 上保证整个进程只有一个连接。
 */
const globalRef = globalThis as unknown as {
  __readflowSqlite?: Database.Database;
};

function openDatabase(): Database.Database {
  const sqlite = new Database(dbPath);

  // busy_timeout：遇到锁时等待而不是立刻报错
  sqlite.pragma("busy_timeout = 10000");
  // WAL：读写并发，读者不阻塞写者
  sqlite.pragma("journal_mode = WAL");
  // NORMAL 同步级别：WAL 下安全且比 FULL 快很多
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");

  return sqlite;
}

const sqlite: Database.Database = globalRef.__readflowSqlite ?? openDatabase();
if (!globalRef.__readflowSqlite) {
  globalRef.__readflowSqlite = sqlite;
  process.on("exit", () => {
    try {
      sqlite.close();
    } catch {
      /* 关闭失败无所谓，进程即将退出 */
    }
  });
}

/**
 * 建表语句直接内联：本地单机应用，启动即可用，不依赖 migration 流程。
 * 与 schema.ts 一一对应，改动时两处同步。
 *
 * 热重载可能让多个模块同时执行到这里，CREATE TABLE IF NOT EXISTS 本身幂等，
 * 但并发写会撞锁，所以失败时重试。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS texts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paragraphs (
  id TEXT PRIMARY KEY,
  text_id TEXT NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paragraphs_text ON paragraphs(text_id, idx);

CREATE TABLE IF NOT EXISTS user_words (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  lemma TEXT NOT NULL,
  display_form TEXT NOT NULL,
  pos TEXT,
  phonetic TEXT,
  translation TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_words_lemma ON user_words(user_id, lemma);

CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  user_word_id TEXT NOT NULL REFERENCES user_words(id) ON DELETE CASCADE,
  text_id TEXT NOT NULL,
  paragraph_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  quote TEXT NOT NULL,
  prefix TEXT NOT NULL,
  suffix TEXT NOT NULL,
  ai_gloss TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contexts_word ON contexts(user_word_id);
CREATE INDEX IF NOT EXISTS idx_contexts_para ON contexts(paragraph_id);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  user_word_id TEXT NOT NULL REFERENCES user_words(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL,
  chapter_id TEXT,
  card_id TEXT,
  card_type TEXT NOT NULL DEFAULT 'qa',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  pushed_at INTEGER
);
-- 唯一索引不写在这里：老库的 exports 还没有 card_type 列，
-- 要先 ALTER 加列再建索引，统一放到下面的 migrate() 里做。

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

let lastError: unknown;
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    sqlite.exec(SCHEMA_SQL);
    lastError = undefined;
    break;
  } catch (err) {
    lastError = err;
    // 指数退避重试，最长等待约 1.5s
    const wait = 100 * 2 ** attempt;
    const until = Date.now() + wait;
    while (Date.now() < until) {
      /* busy wait */
    }
  }
}
if (lastError) throw lastError;

/**
 * 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，
 * 而 exports 早期版本没有 card_type（唯一键是 word+deck）。
 * 这一步把旧库升到「word+deck+card_type」的唯一键，可以重复执行。
 */
function migrate(): void {
  const cols = sqlite.prepare("PRAGMA table_info(exports)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "card_type")) {
    sqlite.exec("ALTER TABLE exports ADD COLUMN card_type TEXT NOT NULL DEFAULT 'qa'");
  }
  sqlite.exec("DROP INDEX IF EXISTS uq_exports_word_deck");
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_exports_word_deck_type ON exports(user_word_id, deck_id, card_type)",
  );
}

try {
  migrate();
} catch {
  // 迁移失败不应该让整个应用起不来：导出功能会自己报错，其余功能不受影响
}

export const db = drizzle(sqlite, { schema });
export { sqlite, dbPath };

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "lexreader.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

/**
 * Next.js dev 的热重载会反复重新求值模块，若每次都 new 一个连接，
 * 旧连接不释放会在 WAL 模式下撞上 "disk I/O error"。
 * 挂到 globalThis 上保证整个进程只有一个连接。
 */
const globalRef = globalThis as unknown as {
  __lexreaderSqlite?: Database.Database;
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

const sqlite: Database.Database = globalRef.__lexreaderSqlite ?? openDatabase();
if (!globalRef.__lexreaderSqlite) {
  globalRef.__lexreaderSqlite = sqlite;
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
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  pushed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_exports_word_deck ON exports(user_word_id, deck_id);
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

export const db = drizzle(sqlite, { schema });
export { sqlite, dbPath };

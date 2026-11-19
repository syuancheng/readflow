import type Database from "better-sqlite3";

/**
 * 常用问题（P44）：用户自己加的快捷问题，点一下就发给 AI。按账号保存，换设备也在。
 * 启动时执行，可以重复执行。
 */
export function ensureQuickQuestions(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS quick_questions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quick_questions_user ON quick_questions (user_id, created_at);
  `);
}

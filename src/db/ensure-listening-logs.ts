import type Database from "better-sqlite3";

/**
 * 听力战绩记录表（P60）与阅读完读统计索引。
 * 启动时执行，幂等可重复运行。
 */
export function ensureListeningLogs(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS listening_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      log_date TEXT NOT NULL,
      minutes REAL NOT NULL,
      mode TEXT NOT NULL DEFAULT 'intensive',
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      text_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listening_logs_user_date
      ON listening_logs (user_id, log_date);
    CREATE INDEX IF NOT EXISTS idx_texts_user_completed
      ON texts (user_id, completed_at);
  `);
}

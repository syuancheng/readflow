import type Database from "better-sqlite3";

/**
 * 表结构整理（2026-11-14）：
 * 1. 合并 ai_usage + card_usage → daily_usage(user_id, day, kind, count)，kind = 'ai' | 'card'；
 * 2. （原来这里删掉空的 tts_audio / markji_media；P35 改由 ensure-audio.ts 按新结构建表，
 *    旧结构的空表也在那里删。）
 *
 * 启动时执行，全部在一个事务里，要么全做成要么全不做；可以重复执行（旧表不在了就什么也不做）。
 */
export function ensureDailyUsage(sqlite: Database.Database): void {
  const exists = (name: string) =>
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS daily_usage (
        user_id TEXT NOT NULL,
        day TEXT NOT NULL,                       -- 上海时区的自然日，如 2026-11-14
        kind TEXT NOT NULL CHECK (kind IN ('ai', 'card')),
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day, kind)
      );
    `);

    for (const [table, kind] of [
      ["ai_usage", "ai"],
      ["card_usage", "card"],
    ] as const) {
      if (!exists(table)) continue;
      // 万一新表里已有同一天的计数（理论上不会），取较大的，宁可少给不多给
      sqlite
        .prepare(
          `INSERT INTO daily_usage (user_id, day, kind, count)
           SELECT user_id, day, ?, count FROM ${table} WHERE true -- SQLite 要求 SELECT 带 WHERE 才能接 ON CONFLICT
           ON CONFLICT(user_id, day, kind) DO UPDATE SET count = MAX(count, excluded.count)`,
        )
        .run(kind);
      sqlite.exec(`DROP TABLE ${table}`);
    }

  })();
}

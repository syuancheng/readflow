import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * 唯一的 SQLite 连接。
 * 单独成文件，是为了让 scripts/verify-*（CommonJS 编译）也能读 settings，
 * 而不必把 schema.ts 卷进来 —— 那里面 `export const exports` 与 CJS 保留字冲突。
 */
const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "readflow.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const globalRef = globalThis as unknown as {
  __readflowSqlite?: Database.Database;
};

function openDatabase(): Database.Database {
  const sqlite = new Database(dbPath);
  sqlite.pragma("busy_timeout = 10000");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

export const sqlite: Database.Database = globalRef.__readflowSqlite ?? openDatabase();

if (!globalRef.__readflowSqlite) {
  globalRef.__readflowSqlite = sqlite;
  // 配置表在连接层就保证存在：设置中心可能先于主 schema 初始化被读取
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  process.on("exit", () => {
    try {
      sqlite.close();
    } catch {
      /* 进程即将退出，关闭失败无所谓 */
    }
  });
}

export { dbPath };

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureAuthSchema } from "./ensure-auth";

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
  // 配置表与账户表在连接层就保证存在：登录 API / 设置中心可能先于
  // 主 schema 初始化被读取。老库的 settings 在这里原地重建为按用户隔离。
  ensureAuthSchema(sqlite);
  process.on("exit", () => {
    try {
      sqlite.close();
    } catch {
      /* 进程即将退出，关闭失败无所谓 */
    }
  });
}

export { dbPath };

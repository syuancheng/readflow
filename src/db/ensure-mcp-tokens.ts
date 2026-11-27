import type Database from "better-sqlite3";

/**
 * MCP 接入 Token（P61）：每个账号一个，只存 sha256 哈希。
 * 启动时执行，幂等可重复运行。
 */
export function ensureMcpTokens(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      user_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      token_hint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);
}

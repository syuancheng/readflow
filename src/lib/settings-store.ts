/**
 * 配置持久化：复用已有的 settings 键值表。
 * 所有密钥只落本地 SQLite，不进环境变量、不进 git。
 *
 * 这里走原生参数化 SQL 而非 drizzle，是为了让 scripts/verify-*（CommonJS）
 * 也能复用同一个连接模块，不必把 schema.ts 卷进编译。
 */
import { sqlite } from "../db/sqlite";
import type { SettingsMap } from "./config";

type Row = { value: string };

export function getSetting(key: string): string | null {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
}

export function deleteSetting(key: string): void {
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/** 一次性读全表（配置项很少，避免 N 次查询） */
export function allSettings(): SettingsMap {
  const rows = sqlite.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

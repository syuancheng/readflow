import type Database from "better-sqlite3";
import { addColumnIfMissing } from "./alter";

/**
 * 给已存在的 texts 表补「分类 + 阅读进度 + 已读完」列（P16 / P18）。
 *
 * 与 ensure-cefr.ts 同一个模式：CREATE TABLE IF NOT EXISTS 不会给老库加列，
 * 抽成独立模块让应用启动迁移和离线脚本共用同一份列定义。
 * 幂等：先 PRAGMA 查列再 ALTER，重复执行安全。
 *
 * completed_at 可空，老库补列后全部为 NULL —— 正好对应「从未手动标记读完」，
 * 不需要为 P18 写数据迁移脚本。
 */
const META_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["category", "TEXT"],
  ["read_idx", "INTEGER"],
  ["read_ratio", "REAL"],
  ["completed_at", "INTEGER"],
];

export function ensureTextMetaColumns(sqlite: Database.Database): void {
  const cols = sqlite.prepare("PRAGMA table_info(texts)").all() as { name: string }[];
  for (const [name, def] of META_COLUMNS) {
    if (!cols.some((c) => c.name === name)) {
      addColumnIfMissing(sqlite, `ALTER TABLE texts ADD COLUMN ${name} ${def}`, "texts", name);
    }
  }
}

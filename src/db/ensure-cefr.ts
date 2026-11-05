import type Database from "better-sqlite3";

/**
 * 给已存在的 texts 表补 CEFR 列。
 *
 * CREATE TABLE IF NOT EXISTS 不会给老库加列，所以迁移必须单独做。
 * 抽成独立模块是为了让「应用启动时的迁移」和「回填脚本」共用同一份列定义：
 * 回填脚本直连数据库、不加载 src/db/index.ts（那个模块会把 schema.ts
 * 拖进 CommonJS 单测编译链），但两者必须补出完全一样的表结构。
 *
 * 幂等：每次都是先 PRAGMA 查列再 ALTER，重复执行安全。
 */
const CEFR_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["cefr_level", "TEXT"],
  ["cefr_score", "REAL"],
  ["cefr_detail", "TEXT"],
  ["cefr_method", "TEXT"],
  ["cefr_overridden", "INTEGER NOT NULL DEFAULT 0"],
];

export function ensureCefrColumns(sqlite: Database.Database): void {
  const cols = sqlite.prepare("PRAGMA table_info(texts)").all() as { name: string }[];
  for (const [name, def] of CEFR_COLUMNS) {
    if (!cols.some((c) => c.name === name)) {
      sqlite.exec(`ALTER TABLE texts ADD COLUMN ${name} ${def}`);
    }
  }
}

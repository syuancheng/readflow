import type Database from "better-sqlite3";
import { addColumnIfMissing } from "./alter";

/**
 * 结构化导入（Block IR）需要的列。
 *
 * 与 CEFR 那次同样的理由：应用启动时的 migrate() 和离线脚本必须补出
 * **完全一样**的表结构，所以 ALTER 定义抽到这个共享模块里。
 * 这里刻意不 import src/db/index.ts —— 那个链会把 schema.ts 拉进
 * CommonJS 编译，撞上 `export const exports` 的保留字冲突。
 */
const TEXT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["source_format", "TEXT NOT NULL DEFAULT 'plain'"],
  ["source_raw", "TEXT"],
];

const PARAGRAPH_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["block_type", "TEXT NOT NULL DEFAULT 'paragraph'"],
  ["block_meta", "TEXT"],
  ["inline_ranges", "TEXT"],
];

function ensure(sqlite: Database.Database, table: "texts" | "paragraphs", columns: typeof TEXT_COLUMNS): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  for (const [name, def] of columns) {
    if (!cols.some((c) => c.name === name)) {
      addColumnIfMissing(sqlite, `ALTER TABLE ${table} ADD COLUMN ${name} ${def}`, table, name);
    }
  }
}

export function ensureBlockColumns(sqlite: Database.Database): void {
  ensure(sqlite, "texts", TEXT_COLUMNS);
  ensure(sqlite, "paragraphs", PARAGRAPH_COLUMNS as typeof TEXT_COLUMNS);
}

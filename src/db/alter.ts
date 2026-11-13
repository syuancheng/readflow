/**
 * 加列的幂等封装。
 *
 * 空库构建时 Next 可能同时拉起多个 worker，它们各自在 sqlite.ts / db/index.ts
 * 模块加载阶段执行 ensureAuthSchema / migrate。两个进程都先读到「列不存在」，
 * 再同时 ALTER，就会有一个撞上 `duplicate column name`。
 * 这里在报错后重新查一次表结构：列已经在（别的进程加好了）就当成功。
 *
 * table / column 只来自代码里的字面量，不来自用户输入。
 */
import type Database from "better-sqlite3";

export function addColumnIfMissing(
  sqlite: Database.Database,
  sql: string,
  table: string,
  column: string,
): void {
  try {
    sqlite.exec(sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column|already exists/i.test(msg)) throw err;
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) throw err;
  }
}

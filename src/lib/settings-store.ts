/**
 * 配置持久化：复用已有的 settings 键值表。
 * 所有密钥只落本地 SQLite，不进环境变量、不进 git。
 *
 * 这里走原生参数化 SQL 而非 drizzle，是为了让 scripts/verify-*（CommonJS）
 * 也能复用同一个连接模块，不必把 schema.ts 卷进编译。
 *
 * P20「站级默认 + 用户覆盖」：
 *   - 不传 userId（或传 GLOBAL_USER）= 读写站级行。ai.ts / markji.ts /
 *     插件 API 都是无请求上下文的同步函数，继续这样读，零改动。
 *   - 传真实账号 id = 先读该账号自己的行，没有再回退站级默认。
 *   - profile.* 是纯个人数据，**不回退**，否则 A 用户会看到 owner 的昵称。
 */
import { sqlite } from "../db/sqlite";
import { GLOBAL_USER } from "../db/ensure-auth";
import type { SettingsMap } from "./config";

type Row = { value: string };

/** 这些 key 只属于具体账号，站级值不参与回退 */
function isPersonalKey(key: string): boolean {
  return key.startsWith("profile.");
}

export function getSetting(key: string, userId: string = GLOBAL_USER): string | null {
  if (userId !== GLOBAL_USER) {
    const own = sqlite
      .prepare("SELECT value FROM settings WHERE user_id = ? AND key = ?")
      .get(userId, key) as Row | undefined;
    if (own) return own.value;
    if (isPersonalKey(key)) return null;
  }
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE user_id = ? AND key = ?")
    .get(GLOBAL_USER, key) as Row | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string, userId: string = GLOBAL_USER): void {
  sqlite
    .prepare(
      `INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(userId, key, value, Date.now());
}

export function deleteSetting(key: string, userId: string = GLOBAL_USER): void {
  sqlite.prepare("DELETE FROM settings WHERE user_id = ? AND key = ?").run(userId, key);
}

/** 一次性读全表（配置项很少，避免 N 次查询）；个人行覆盖同名站级行。 */
export function allSettings(userId?: string): SettingsMap {
  const rows = sqlite
    .prepare("SELECT user_id, key, value FROM settings")
    .all() as { user_id: string; key: string; value: string }[];
  const out: SettingsMap = {};
  for (const r of rows) {
    if (r.user_id === GLOBAL_USER) {
      if (userId && isPersonalKey(r.key)) continue; // 站级资料不泄漏给账号
      out[r.key] = r.value;
    }
  }
  if (userId && userId !== GLOBAL_USER) {
    for (const r of rows) {
      if (r.user_id === userId) out[r.key] = r.value;
    }
  }
  return out;
}

/**
 * 首次建号时把老库的个人资料从站级迁到 owner 名下。
 * 只迁 profile.*，密钥类留在站级供所有人（含插件链路）使用。
 */
export function migrateProfileToUser(userId: string): void {
  if (userId === GLOBAL_USER) return;
  const rows = sqlite
    .prepare("SELECT key, value, updated_at FROM settings WHERE user_id = ? AND key LIKE 'profile.%'")
    .all(GLOBAL_USER) as { key: string; value: string; updated_at: number }[];
  if (rows.length === 0) return;
  const insert = sqlite.prepare(
    `INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
  );
  const del = sqlite.prepare("DELETE FROM settings WHERE user_id = ? AND key = ?");
  // 不在这里开事务：调用方（setup）会把「建号 + 老数据迁移」包成一个事务，
  // 避免建号成功但资料/文章没归属到 owner 的半个状态。
  for (const r of rows) {
    insert.run(userId, r.key, r.value, r.updated_at);
    del.run(GLOBAL_USER, r.key);
  }
}

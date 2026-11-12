/**
 * 浏览器插件 Token（P30）：每个账号一个，插件凭它代表「这个人」读写数据。
 *
 * - 只存 sha256（与 session 同一套做法），数据库泄露也拿不到可用的 Token；
 *   明文只在生成那一刻返回给设置页，之后只能重新生成。
 * - 一人一个：重新生成直接覆盖旧行，旧 Token 立即失效。
 * - 兼容 P30 之前的「站级共用 Token」（settings 表 user_id='local' 的 extension.token 明文）：
 *   第一次用到时把它迁成站长本人的 Token 并删掉明文，站长插件里已经填好的值继续有效。
 */
import { randomBytes } from "node:crypto";
import { sqlite } from "@/db/sqlite";
import { GLOBAL_USER } from "@/db/ensure-auth";
import { tokenHash } from "@/lib/auth-crypto";
import type { AuthUser } from "@/lib/auth";
import { SETTINGS_KEYS } from "@/lib/config";

export type ExtensionTokenStatus = {
  hasToken: boolean;
  /** 末 4 位，用来认出是哪一个 Token */
  hint: string | null;
  createdAt: number | null;
  lastUsedAt: number | null;
};

/** last_used_at 最多每分钟写一次，插件高频请求不必每次都写库 */
const TOUCH_INTERVAL_MS = 60_000;

let legacyChecked = false;

/** 旧版站级 Token → 站长本人的 Token（幂等，每个进程只真正检查一次） */
export function migrateLegacyExtensionToken(): void {
  if (legacyChecked) return;
  const legacy = sqlite
    .prepare("SELECT value FROM settings WHERE user_id = ? AND key = ?")
    .get(GLOBAL_USER, SETTINGS_KEYS.extensionToken) as { value: string } | undefined;
  const owner = sqlite
    .prepare("SELECT id FROM users WHERE is_owner = 1 ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  // 还没有站长（全新安装）：等建号后再迁，先不标记已检查
  if (legacy?.value && !owner) return;
  legacyChecked = true;
  if (!legacy?.value || !owner) return;

  sqlite.transaction(() => {
    const has = sqlite.prepare("SELECT 1 FROM extension_tokens WHERE user_id = ?").get(owner.id);
    if (!has) {
      sqlite
        .prepare(
          "INSERT INTO extension_tokens (user_id, token_hash, token_hint, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(owner.id, tokenHash(legacy.value), legacy.value.slice(-4), Date.now());
    }
    sqlite
      .prepare("DELETE FROM settings WHERE user_id = ? AND key = ?")
      .run(GLOBAL_USER, SETTINGS_KEYS.extensionToken);
  })();
}

/** 生成并保存新 Token，返回明文（只有这一次能拿到） */
export function issueExtensionToken(userId: string): string {
  migrateLegacyExtensionToken();
  const token = `rfx_${randomBytes(24).toString("base64url")}`;
  sqlite
    .prepare(
      `INSERT INTO extension_tokens (user_id, token_hash, token_hint, created_at, last_used_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         token_hint = excluded.token_hint,
         created_at = excluded.created_at,
         last_used_at = NULL`,
    )
    .run(userId, tokenHash(token), token.slice(-4), Date.now());
  return token;
}

export function revokeExtensionToken(userId: string): void {
  migrateLegacyExtensionToken();
  sqlite.prepare("DELETE FROM extension_tokens WHERE user_id = ?").run(userId);
}

export function extensionTokenStatus(userId: string): ExtensionTokenStatus {
  migrateLegacyExtensionToken();
  const row = sqlite
    .prepare("SELECT token_hint, created_at, last_used_at FROM extension_tokens WHERE user_id = ?")
    .get(userId) as { token_hint: string; created_at: number; last_used_at: number | null } | undefined;
  if (!row) return { hasToken: false, hint: null, createdAt: null, lastUsedAt: null };
  return { hasToken: true, hint: row.token_hint, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

/** Token → 账号；无效返回 null。顺手记录最近使用时间。 */
export function userFromExtensionToken(token: string | null | undefined): AuthUser | null {
  if (!token || token.length > 200) return null;
  migrateLegacyExtensionToken();
  const row = sqlite
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.phone, u.is_owner, t.last_used_at
         FROM extension_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`,
    )
    .get(tokenHash(token)) as
    | {
        id: string;
        username: string;
        display_name: string | null;
        phone: string | null;
        is_owner: number;
        last_used_at: number | null;
      }
    | undefined;
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > TOUCH_INTERVAL_MS) {
    sqlite.prepare("UPDATE extension_tokens SET last_used_at = ? WHERE user_id = ?").run(now, row.id);
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    phone: row.phone ?? null,
    isOwner: row.is_owner === 1,
  };
}

/**
 * MCP 接入 Token（P61）：每个账号一个，外部 AI 客户端凭它代表「这个人」读写数据。
 *
 * 沿用 P30 extension_tokens 的安全约定：
 * - 只存 sha256 哈希，明文仅在生成瞬间返回一次；
 * - 重新生成直接覆盖旧行，旧 Token 立即失效；
 * - last_used_at 节流更新（每分钟最多写一次）。
 */
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { sqlite } from "@/db/sqlite";
import { ensureMcpTokens } from "@/db/ensure-mcp-tokens";
import { tokenHash } from "@/lib/auth-crypto";
import type { AuthUser } from "@/lib/auth";

export type McpTokenStatus = {
  hasToken: boolean;
  /** 末 4 位，便于识别 */
  hint: string | null;
  createdAt: number | null;
  lastUsedAt: number | null;
};

const TOUCH_INTERVAL_MS = 60_000;
let ensured = false;

function ensureTable(conn: Database.Database): void {
  if (conn === sqlite) {
    if (ensured) return;
    ensureMcpTokens(conn);
    ensured = true;
  } else {
    ensureMcpTokens(conn);
  }
}

/** 生成并保存新 MCP Token，返回明文（只有这一次能拿到） */
export function issueMcpToken(userId: string, conn: Database.Database = sqlite): string {
  ensureTable(conn);
  const token = `rfm_${randomBytes(24).toString("base64url")}`;
  conn
    .prepare(
      `INSERT INTO mcp_tokens (user_id, token_hash, token_hint, created_at, last_used_at)
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

export function revokeMcpToken(userId: string, conn: Database.Database = sqlite): void {
  ensureTable(conn);
  conn.prepare("DELETE FROM mcp_tokens WHERE user_id = ?").run(userId);
}

export function mcpTokenStatus(userId: string, conn: Database.Database = sqlite): McpTokenStatus {
  ensureTable(conn);
  const row = conn
    .prepare("SELECT token_hint, created_at, last_used_at FROM mcp_tokens WHERE user_id = ?")
    .get(userId) as { token_hint: string; created_at: number; last_used_at: number | null } | undefined;
  if (!row) return { hasToken: false, hint: null, createdAt: null, lastUsedAt: null };
  return {
    hasToken: true,
    hint: row.token_hint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** 从 Authorization: Bearer <token> 或 x-readflow-mcp-token 提取 Token */
export function extractMcpToken(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]?.trim()) return m[1].trim();
  }
  const alt = headers.get("x-readflow-mcp-token")?.trim();
  return alt || null;
}

/** Token → 账号；无效返回 null。顺手节流更新最近使用时间。 */
export function userFromMcpToken(
  token: string | null | undefined,
  conn: Database.Database = sqlite,
): AuthUser | null {
  if (!token || token.length > 200) return null;
  ensureTable(conn);
  const hash = tokenHash(token);
  const row = conn
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.phone, u.is_owner, t.last_used_at
         FROM mcp_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`,
    )
    .get(hash) as
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
  if (!row.last_used_at || now - row.last_used_at >= TOUCH_INTERVAL_MS) {
    conn
      .prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE user_id = ?")
      .run(now, row.id);
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    phone: row.phone,
    isOwner: row.is_owner === 1,
  };
}

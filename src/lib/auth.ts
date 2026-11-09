/**
 * 服务端会话（P20）。
 *
 * middleware 只判断「有没有 cookie」（Edge runtime 用不了 node:crypto），
 * 真正的校验一律在这里、在 Node runtime 完成：token → sha256 → sessions 表
 * → 关联 users → 检查过期。 cookie 伪造、过期、已登出的 session 都会在这里挡掉。
 *
 * 没有用 Auth.js / Clerk / Supabase：本地 SQLite + Node 内置 crypto 就够，
 * 零依赖、零月费、断网可用，也符合「要收费就放弃」的前提。
 */
import { cookies } from "next/headers";
import { sqlite } from "@/db/sqlite";
import {
  isSessionExpired,
  newSessionToken,
  SESSION_TTL_MS,
  tokenHash,
} from "./auth-crypto";
import { GLOBAL_USER } from "@/db/ensure-auth";
export { GLOBAL_USER };

export const SESSION_COOKIE = "readflow_session";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string | null;
  isOwner: boolean;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string | null;
  is_owner: number;
};

export function hasAnyUser(): boolean {
  const row = sqlite.prepare("SELECT 1 AS x FROM users LIMIT 1").get() as { x: number } | undefined;
  return Boolean(row);
}

export function userCount(): number {
  const row = sqlite.prepare("SELECT count(*) AS n FROM users").get() as { n: number };
  return row.n;
}

/** 插件链路（无 cookie，用站级 extension token 鉴权）把数据归到 owner 名下。 */
export function ownerId(): string {
  const row = sqlite
    .prepare("SELECT id FROM users WHERE is_owner = 1 ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? GLOBAL_USER;
}

export function findUserByUsername(username: string): (UserRow & { password_hash: string }) | undefined {
  return sqlite
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as (UserRow & { password_hash: string }) | undefined;
}

export function findUserById(id: string): UserRow | undefined {
  return sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

/** 从请求里解析当前用户；未登录 / 无效 / 过期一律返回 null。 */
export async function currentUser(): Promise<AuthUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return userFromToken(token);
}

/** 供 API 显式调用的可测试版本（不依赖请求上下文）。 */
export function userFromToken(token: string | null | undefined): AuthUser | null {
  if (!token) return null;
  const row = sqlite
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_owner, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(tokenHash(token)) as (UserRow & { expires_at: number }) | undefined;
  if (!row || isSessionExpired(row.expires_at)) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isOwner: row.is_owner === 1,
  };
}

/** 建一条 session，返回原始 token（只给 cookie，不落库）。 */
export function createSession(userId: string): string {
  const token = newSessionToken();
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(tokenHash(token), userId, now + SESSION_TTL_MS, now);
  // 顺手清掉该用户的过期 session，避免表无限增长
  sqlite.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  return token;
}

export function revokeSession(token: string | null | undefined): void {
  if (!token) return;
  sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

/** cookie 选项：本地 HTTP 下 Secure=false；经 HTTPS 隧道访问时自动打开。 */
export function sessionCookieOptions(req: Request, token: string | null) {
  const proto = req.headers.get("x-forwarded-proto") ?? "";
  const secure = proto.split(",")[0]?.trim() === "https";
  return {
    name: SESSION_COOKIE,
    value: token ?? "",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: token ? Math.floor(SESSION_TTL_MS / 1000) : 0,
  };
}

/**
 * 登录失败限速（进程内计数器）。
 * 公网暴露后这是必要的第一道防线；单进程部署足够，重启即清零。
 */
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

export function loginRateKey(req: Request, username: string): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  return `${ip}|${username.toLowerCase()}`;
}

export function isRateLimited(key: string, now = Date.now()): boolean {
  const rec = failures.get(key);
  if (!rec) return false;
  if (rec.until <= now) {
    failures.delete(key);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}

export function noteLoginFailure(key: string, now = Date.now()): void {
  const rec = failures.get(key);
  if (!rec || rec.until <= now) {
    failures.set(key, { count: 1, until: now + LOCK_MS });
  } else {
    rec.count += 1;
  }
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}

/** 复用于单测与诊断：清空限速表，不影响上面的 Map 常量引用 */
export function resetRateLimits(): void {
  failures.clear();
}

/**
 * 账户密码与会话令牌的纯函数层（P20）。
 *
 * 刻意不引第三方 auth 库、不碰 Next / DB：
 *   - scrypt 是 Node 内置的抗 GPU 暴力破解 KDF，本地单机零成本；
 *   - 单独成文件是为了能被 tsconfig.unit.json 直接编译做单测；
 *   - 会话 token 只以 sha256 哈希落库，DB 泄露也换不到登录态。
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const KEY_LEN = 64;
const SCRYPT_COST = 16384; // N = 2^14，约 40ms/次，足够挡住本机暴力尝试
const SCRYPT_BLOCK = 8;
const SCRYPT_PARALLEL = 1;

export type PasswordRules = { ok: boolean; reason?: string };

/** 用户名：3–32 位，字母数字下划线/中划线，允许中文 */
export function checkUsername(v: unknown): PasswordRules {
  if (typeof v !== "string") return { ok: false, reason: "用户名不能为空" };
  const s = v.trim();
  if (s.length < 2 || s.length > 32) return { ok: false, reason: "用户名需 2–32 个字符" };
  if (!/^[\p{L}\p{N}_.-]+$/u.test(s)) {
    return { ok: false, reason: "用户名只能包含中英文、数字、_ . -" };
  }
  return { ok: true };
}

/** 密码：至少 8 位。本地服务不搞复杂度策略，长度才是有效熵。 */
export function checkPassword(v: unknown): PasswordRules {
  if (typeof v !== "string") return { ok: false, reason: "密码不能为空" };
  if (v.length < 8) return { ok: false, reason: "密码至少 8 位" };
  if (v.length > 256) return { ok: false, reason: "密码过长" };
  return { ok: true };
}

/** 生成 "scrypt$<salt hex>$<hash hex>" 形式的密码哈希。 */
export function hashPassword(password: string, salt = randomBytes(16)): string {
  const derived = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** 恒定时间比较；格式不合法时返回 false 而不是抛错。 */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (typeof password !== "string" || !stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length === 0 || expected.length !== KEY_LEN) return false;
    const actual = scryptSync(password, salt, KEY_LEN, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK,
      p: SCRYPT_PARALLEL,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 浏览器拿到的原始 token；服务端只存它的哈希。 */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 30 天后过期；每次登录重新发一个 session，不做滑动续期（简单、可吊销）。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function isSessionExpired(expiresAt: number, now = Date.now()): boolean {
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

export function newUserId(): string {
  return randomUUID();
}

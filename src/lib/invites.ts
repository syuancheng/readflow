/**
 * 邀请码（P28）。
 *
 * 不开放注册：陌生人注册后会花 owner 的 AI 额度。owner 在「设置 → 邀请朋友」里发码，
 * 朋友拿码在 /register 注册。每个码可用 max_uses 次，可随时作废（已注册的账号不受影响）。
 */
import { randomInt } from "node:crypto";
import { sqlite } from "@/db/sqlite";

/** 去掉 0/O/1/I/L 这类容易看错的字符 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type InviteRow = {
  code: string;
  note: string | null;
  maxUses: number;
  usedCount: number;
  revoked: boolean;
  createdAt: number;
  /** 用这个码注册的账号用户名 */
  usedBy: string[];
};

/** 8 位，形如 K7QM-3XPA；输入时大小写、横杠、空格都不敏感 */
export function newInviteCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normalizeInviteCode(v: unknown): string {
  if (typeof v !== "string") return "";
  const raw = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : "";
}

export function createInvite(createdBy: string, maxUses: number, note: string | null): string {
  const uses = Math.min(Math.max(Math.floor(maxUses) || 1, 1), 50);
  for (let i = 0; i < 5; i++) {
    const code = newInviteCode();
    const r = sqlite
      .prepare(
        "INSERT OR IGNORE INTO invites (code, created_by, note, max_uses, used_count, revoked, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
      )
      .run(code, createdBy, note?.trim().slice(0, 40) || null, uses, Date.now());
    if (r.changes === 1) return code;
  }
  throw new Error("生成邀请码失败，请重试");
}

export function listInvites(): InviteRow[] {
  const rows = sqlite
    .prepare("SELECT code, note, max_uses, used_count, revoked, created_at FROM invites ORDER BY created_at DESC")
    .all() as { code: string; note: string | null; max_uses: number; used_count: number; revoked: number; created_at: number }[];
  const users = sqlite
    .prepare("SELECT username, invite_code FROM users WHERE invite_code IS NOT NULL ORDER BY created_at")
    .all() as { username: string; invite_code: string }[];
  return rows.map((r) => ({
    code: r.code,
    note: r.note,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    revoked: r.revoked === 1,
    createdAt: r.created_at,
    usedBy: users.filter((u) => u.invite_code === r.code).map((u) => u.username),
  }));
}

export function revokeInvite(code: string): boolean {
  return sqlite.prepare("UPDATE invites SET revoked = 1 WHERE code = ?").run(code).changes === 1;
}

/**
 * 在事务里占用一次邀请码；不可用时抛出带中文原因的 Error。
 * 必须与建号在同一个事务里调用：建号失败（用户名重复等）时名额会一起回滚。
 */
export function consumeInvite(code: string): void {
  const row = sqlite
    .prepare("SELECT max_uses, used_count, revoked FROM invites WHERE code = ?")
    .get(code) as { max_uses: number; used_count: number; revoked: number } | undefined;
  if (!row || row.revoked) throw new InviteError("邀请码不对，或者已经作废了");
  if (row.used_count >= row.max_uses) throw new InviteError("这个邀请码已经用完了，请找邀请你的人要一个新的");
  sqlite.prepare("UPDATE invites SET used_count = used_count + 1 WHERE code = ?").run(code);
}

export class InviteError extends Error {}

/**
 * POST /api/auth/register —— 凭邀请码注册（P28）。
 *
 * 不开放注册：必须带 owner 发的邀请码。占用邀请码与建号在同一个事务里，
 * 用户名 / 手机号重复导致建号失败时，名额一起回滚，不会白白消耗。
 * 邀请码填错按来源限速（与登录同一套），防止有人暴力试码。
 */
import { NextResponse } from "next/server";
import { sqlite } from "@/db/sqlite";
import {
  checkPassword,
  checkPhone,
  checkUsername,
  hashPassword,
  newUserId,
  normalizePhone,
} from "@/lib/auth-crypto";
import {
  clearLoginFailures,
  createSession,
  findUserByPhone,
  findUserByUsername,
  hasAnyUser,
  isRateLimited,
  loginRateKey,
  noteLoginFailure,
  sessionCookieOptions,
} from "@/lib/auth";
import { consumeInvite, InviteError, normalizeInviteCode } from "@/lib/invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!hasAnyUser()) {
    return NextResponse.json({ error: "站点还没有主账号，请先完成首次建号" }, { status: 403 });
  }
  const rateKey = loginRateKey(req, "register");
  if (isRateLimited(rateKey)) {
    return NextResponse.json({ error: "邀请码错误次数太多，请一分钟后再试" }, { status: 429 });
  }

  let body: { inviteCode?: unknown; username?: unknown; phone?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const code = normalizeInviteCode(body?.inviteCode);
  if (!code) {
    noteLoginFailure(rateKey);
    return NextResponse.json({ error: "请填写 8 位邀请码，例如 K7QM-3XPA" }, { status: 400 });
  }
  const u = checkUsername(body?.username);
  if (!u.ok) return NextResponse.json({ error: u.reason }, { status: 400 });
  const ph = checkPhone(body?.phone);
  if (!ph.ok) return NextResponse.json({ error: ph.reason }, { status: 400 });
  const p = checkPassword(body?.password);
  if (!p.ok) return NextResponse.json({ error: p.reason }, { status: 400 });

  const username = (body.username as string).trim();
  const phone = normalizePhone(body.phone)!;
  const id = newUserId();
  const hash = hashPassword(body.password as string);

  try {
    sqlite.transaction(() => {
      if (findUserByUsername(username)) throw new InviteError("这个用户名已经有人用了，换一个吧");
      if (findUserByPhone(phone)) throw new InviteError("这个手机号已经注册过了，直接去登录吧");
      consumeInvite(code);
      sqlite
        .prepare(
          `INSERT INTO users (id, username, phone, password_hash, display_name, is_owner, invite_code, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(id, username, phone, hash, username, code, Date.now());
    })();
  } catch (err) {
    if (err instanceof InviteError) {
      if (/邀请码/.test(err.message)) noteLoginFailure(rateKey);
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // 并发下 UNIQUE 冲突（两人同时抢一个用户名 / 手机号）
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      return NextResponse.json({ error: "用户名或手机号已经被注册了" }, { status: 400 });
    }
    console.error("[auth/register] 注册失败", err);
    return NextResponse.json({ error: "注册失败，请稍后再试" }, { status: 500 });
  }

  clearLoginFailures(rateKey);
  const token = createSession(id);
  const res = NextResponse.json({ ok: true, user: { id, username, phone, displayName: username } });
  res.cookies.set(sessionCookieOptions(req, token));
  return res;
}

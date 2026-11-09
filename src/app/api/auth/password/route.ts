/**
 * POST /api/auth/password —— 修改当前账号密码。
 * 改完吊销该账号全部 session（含其它设备），再给本次请求发一个新 session，
 * 保证「改密码即踢掉所有旧登录态」，用户自己不用重新输密码。
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sqlite } from "@/db/sqlite";
import { checkPassword, hashPassword, verifyPassword } from "@/lib/auth-crypto";
import {
  createSession,
  currentUser,
  findUserById,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (typeof body?.currentPassword !== "string" || typeof body?.newPassword !== "string") {
    return NextResponse.json({ error: "请填写原密码和新密码" }, { status: 400 });
  }
  const rule = checkPassword(body.newPassword);
  if (!rule.ok) return NextResponse.json({ error: rule.reason }, { status: 400 });

  const row = findUserById(user.id) as { password_hash: string } | undefined;
  if (!row || !verifyPassword(body.currentPassword, row.password_hash)) {
    return NextResponse.json({ error: "原密码不正确" }, { status: 401 });
  }

  const store = await cookies();
  const oldToken = store.get(SESSION_COOKIE)?.value;
  const hash = hashPassword(body.newPassword);
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
    sqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  })();

  const token = createSession(user.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookieOptions(req, token));
  // 旧 token 已被 DELETE 清掉，这里只是让调用方不必再关心它
  void oldToken;
  return res;
}

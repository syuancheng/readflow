/**
 * POST /api/auth/login —— 账号（用户名或手机号）+ 密码登录。
 * body: { account, password }；旧字段 username 仍接受，含义相同。
 * 密码比对用 scrypt + timingSafeEqual；失败按 (IP, 用户名) 限速，
 * 5 次失败锁 60 秒（公网暴露后这是必要的低成本防线）。
 */
import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth-crypto";
import {
  clearLoginFailures,
  createSession,
  findUserByLogin,
  isRateLimited,
  loginRateKey,
  noteLoginFailure,
  sessionCookieOptions,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { account?: unknown; username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const rawAccount = body?.account ?? body?.username;
  if (typeof rawAccount !== "string" || !rawAccount.trim() || typeof body?.password !== "string") {
    return NextResponse.json({ error: "请输入用户名或手机号，以及密码" }, { status: 400 });
  }

  const account = rawAccount.trim();
  const user = findUserByLogin(account);
  // 限速按「账号本身」计：同一个人换着用用户名 / 手机号试密码，仍然共用一个计数
  const key = loginRateKey(req, user ? `uid:${user.id}` : account);
  if (isRateLimited(key)) {
    return NextResponse.json({ error: "尝试次数过多，请 1 分钟后再试" }, { status: 429 });
  }

  // 用户不存在时也做一次等价的哈希计算，避免通过响应耗时枚举用户名
  const ok = verifyPassword(
    body.password,
    user?.password_hash ?? "scrypt$00000000000000000000000000000000$" + "00".repeat(64),
  );
  if (!user || !ok) {
    noteLoginFailure(key);
    return NextResponse.json({ error: "账号或密码不正确" }, { status: 401 });
  }

  clearLoginFailures(key);
  const token = createSession(user.id);
  const res = NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name ?? user.username,
      phone: user.phone ?? null,
      isOwner: user.is_owner === 1,
    },
  });
  res.cookies.set(sessionCookieOptions(req, token));
  return res;
}

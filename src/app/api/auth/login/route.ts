/**
 * POST /api/auth/login —— 用户名 + 密码登录。
 * 密码比对用 scrypt + timingSafeEqual；失败按 (IP, 用户名) 限速，
 * 5 次失败锁 60 秒（公网暴露后这是必要的低成本防线）。
 */
import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth-crypto";
import {
  clearLoginFailures,
  createSession,
  findUserByUsername,
  isRateLimited,
  loginRateKey,
  noteLoginFailure,
  sessionCookieOptions,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (typeof body?.username !== "string" || typeof body?.password !== "string") {
    return NextResponse.json({ error: "请输入用户名和密码" }, { status: 400 });
  }

  const username = body.username.trim();
  const key = loginRateKey(req, username);
  if (isRateLimited(key)) {
    return NextResponse.json({ error: "尝试次数过多，请 1 分钟后再试" }, { status: 429 });
  }

  const user = findUserByUsername(username);
  // 用户不存在时也做一次等价的哈希计算，避免通过响应耗时枚举用户名
  const ok = verifyPassword(
    body.password,
    user?.password_hash ?? "scrypt$00000000000000000000000000000000$" + "00".repeat(64),
  );
  if (!user || !ok) {
    noteLoginFailure(key);
    return NextResponse.json({ error: "用户名或密码不正确" }, { status: 401 });
  }

  clearLoginFailures(key);
  const token = createSession(user.id);
  const res = NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name ?? user.username,
      isOwner: user.is_owner === 1,
    },
  });
  res.cookies.set(sessionCookieOptions(req, token));
  return res;
}

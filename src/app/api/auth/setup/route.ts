/**
 * POST /api/auth/setup —— 首次启动建号（关闭开放注册，只有这一个入口）。
 *
 * 只在 users 表为空时可用。建号的同时把老库里 user_id='local' 的文章、词库
 * 一次性改挂到 owner 名下，并把 profile.* 从站级迁过去 —— 用户不会丢数据，
 * 也不需要手动跑迁移脚本。之后想加人由 owner 用命令行脚本添加。
 */
import { NextResponse } from "next/server";
import { sqlite } from "@/db/sqlite";
import { GLOBAL_USER } from "@/db/ensure-auth";
import {
  checkPassword,
  checkUsername,
  hashPassword,
  newUserId,
} from "@/lib/auth-crypto";
import {
  createSession,
  hasAnyUser,
  sessionCookieOptions,
} from "@/lib/auth";
import { migrateProfileToUser } from "@/lib/settings-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (hasAnyUser()) {
    return NextResponse.json({ error: "账号已创建，请直接登录" }, { status: 403 });
  }

  let body: { username?: unknown; password?: unknown; displayName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const u = checkUsername(body?.username);
  if (!u.ok) return NextResponse.json({ error: u.reason }, { status: 400 });
  const p = checkPassword(body?.password);
  if (!p.ok) return NextResponse.json({ error: p.reason }, { status: 400 });

  const username = (body.username as string).trim();
  const password = body.password as string;
  const displayName =
    typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim().slice(0, 40)
      : username;
  const id = newUserId();
  const hash = hashPassword(password);

  // 并发双击 /setup 时，UNIQUE(username) 会挡住第二个；用事务保证
  // 「建号 + 老数据归属 + 资料迁移」要么全成、要么全不成。
  try {
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO users (id, username, password_hash, display_name, is_owner, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .run(id, username, hash, displayName, Date.now());
      // 全新空库上连接层只建了 users/sessions/settings，主表要等第一次
      // import @/db 才由 db/index.ts 建立。老库迁移必须容忍表不存在，
      // 否则事务抛错会被下面的 catch 误判成「账号已存在」返回 403。
      for (const table of ["texts", "user_words"] as const) {
        const exists = sqlite
          .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?")
          .get(table);
        if (exists) {
          sqlite.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(id, GLOBAL_USER);
        }
      }
      migrateProfileToUser(id);
    })();
  } catch (err) {
    // 并发双击 /setup 时 UNIQUE(username) 冲突，确实是「已经建好了」；
    // 其它异常要如实报出来，别把它伪装成 403 掩盖真实故障。
    if (hasAnyUser()) {
      return NextResponse.json({ error: "账号已创建，请直接登录" }, { status: 403 });
    }
    console.error("[auth/setup] 建号事务失败", err);
    return NextResponse.json({ error: "建号失败，请查看服务日志" }, { status: 500 });
  }

  const token = createSession(id);
  const res = NextResponse.json({ ok: true, user: { id, username, displayName } });
  res.cookies.set(sessionCookieOptions(req, token));
  return res;
}

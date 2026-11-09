/** GET /api/auth/me —— 当前登录态，供前端菜单展示用户名 / 登出按钮。 */
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  return NextResponse.json({ user });
}

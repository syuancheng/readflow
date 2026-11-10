/**
 * GET /api/auth/status —— 公开的启动状态（不含任何敏感信息）。
 * proxy 只查 cookie、不查库，登录页靠它判断该显示
 * 「首次建号」还是「登录」。
 */
import { NextResponse } from "next/server";
import { hasAnyUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ needsSetup: !hasAnyUser() });
}

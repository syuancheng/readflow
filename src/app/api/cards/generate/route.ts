import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { startGenerate } from "@/lib/cards/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cards/generate（P33 spec §7.3）
 * Body: { contextId, answerId?, force? }
 * 立刻返回 { setId, status: "generating" }，生成在后台执行。
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body: { contextId?: unknown; answerId?: unknown; force?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const contextId = typeof body.contextId === "string" ? body.contextId.trim() : "";
  if (!contextId) return NextResponse.json({ error: "缺少 contextId" }, { status: 400 });

  const out = startGenerate(user, {
    contextId,
    answerId: typeof body.answerId === "string" ? body.answerId : undefined,
    force: body.force === true,
  });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ setId: out.setId, status: "generating", reused: out.reused });
}

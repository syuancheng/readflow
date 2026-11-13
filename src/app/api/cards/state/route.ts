import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { cardStateFor } from "@/lib/cards/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cards/state?contextId=  → 阅读页按钮的状态（未做卡 / 生成中 / 已生成 / 失败 / 已推送） */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const contextId = new URL(req.url).searchParams.get("contextId")?.trim() ?? "";
  if (!contextId) return NextResponse.json({ error: "缺少 contextId" }, { status: 400 });
  return NextResponse.json(cardStateFor(user.id, contextId));
}

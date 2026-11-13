import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { startPush } from "@/lib/cards/pusher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cards/push（P33 spec §7.5）
 * Body: { cardIds, deckId, chapterMode: "fixed" | "per_article", chapterId? }
 * 建一个推送任务后立刻返回 { jobId }，后台按墨墨限频逐张推送。
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const out = startPush(user, {
    cardIds: body.cardIds,
    deckId: body.deckId,
    chapterMode: body.chapterMode,
    chapterId: body.chapterId,
  });
  if (!out.ok) return NextResponse.json({ error: out.error, ...(out.jobId ? { jobId: out.jobId } : {}) }, { status: out.status });
  return NextResponse.json({ jobId: out.jobId });
}

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getJobStatus } from "@/lib/cards/pusher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cards/push/:jobId → { done, failed, total, status, error, failures } */
export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { jobId } = await ctx.params;
  const s = getJobStatus(user, jobId);
  if (!s) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  return NextResponse.json(s);
}

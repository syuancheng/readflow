import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { regenerateCard } from "@/lib/cards/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cards/:id/regenerate（P33 spec §7.4）：换一道。
 * 沿用这个词的完整上下文重新出题，原卡作废；不计入每天的额度，每组最多换 5 次。
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { id } = await ctx.params;
  const out = await regenerateCard(user, id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ ok: true });
}

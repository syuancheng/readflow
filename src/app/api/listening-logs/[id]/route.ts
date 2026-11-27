import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { listeningLogs } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { getListeningStats } from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const [row] = await db
    .select({ id: listeningLogs.id, userId: listeningLogs.userId })
    .from(listeningLogs)
    .where(eq(listeningLogs.id, id))
    .limit(1);

  if (!row || row.userId !== user.id) {
    return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  }

  db.delete(listeningLogs)
    .where(and(eq(listeningLogs.id, id), eq(listeningLogs.userId, user.id)))
    .run();

  const stats = await getListeningStats(user.id);
  return NextResponse.json({ ok: true, stats });
}

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getListeningStats, getReadingStats } from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const tab = new URL(req.url).searchParams.get("tab");
  if (tab === "listening") {
    const stats = await getListeningStats(user.id);
    return NextResponse.json({ tab: "listening", stats });
  }
  if (tab === "reading") {
    const stats = await getReadingStats(user.id);
    return NextResponse.json({ tab: "reading", stats });
  }

  const [reading, listening] = await Promise.all([
    getReadingStats(user.id),
    getListeningStats(user.id),
  ]);
  return NextResponse.json({ reading, listening });
}

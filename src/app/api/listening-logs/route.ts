import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { listeningLogs } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { validateListeningInput } from "@/lib/listening";
import { getListeningStats } from "@/lib/stats";
import { dayKey } from "@/lib/streak";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const now = new Date();
  const parsed = validateListeningInput(
    body as { minutes?: unknown; logDate?: unknown; mode?: unknown; note?: unknown },
    dayKey(now),
  );
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const createdAt = now.getTime();
  const { minutes, logDate, mode, note } = parsed.data;

  db.insert(listeningLogs)
    .values({
      id,
      userId: user.id,
      logDate,
      minutes,
      mode,
      note,
      source: "manual",
      textId: null,
      createdAt,
    })
    .run();

  const stats = await getListeningStats(user.id, 14, 18, now);
  return NextResponse.json(
    {
      log: { id, logDate, minutes, mode, note, source: "manual", textId: null, createdAt },
      stats,
    },
    { status: 201 },
  );
}

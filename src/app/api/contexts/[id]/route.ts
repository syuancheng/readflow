import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contexts, userWords } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/contexts/[id]
 * 把 AI 释义回填到某条批注，翻回去看时不用重新请求 AI。
 * 若词条释义还是占位符，顺手补上（词库页也能看到）。
 *
 * Body: { aiGloss: string }
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { aiGloss?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (typeof body.aiGloss !== "string") {
    return NextResponse.json({ error: "aiGloss 必须是字符串" }, { status: 400 });
  }

  const row = db.select().from(contexts).where(eq(contexts.id, id)).get();
  if (!row) {
    return NextResponse.json({ error: "批注不存在" }, { status: 404 });
  }

  const gloss = body.aiGloss;
  db.update(contexts).set({ aiGloss: gloss }).where(eq(contexts.id, id)).run();

  const word = db.select().from(userWords).where(eq(userWords.id, row.userWordId)).get();
  if (word && (word.translation === "(待补充释义)" || !word.translation)) {
    db.update(userWords)
      .set({ translation: gloss.slice(0, 500) })
      .where(eq(userWords.id, word.id))
      .run();
  }

  return NextResponse.json({ ok: true });
}

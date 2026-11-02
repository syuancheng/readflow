import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userWords, contexts, LOCAL_USER } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/words/[id]
 * 删除一个词：同时删 user_words 和它关联的 contexts。
 * 如果带 ?contextId=xxx，只删那一条 context，不删词本身。
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const contextId = url.searchParams.get("contextId");

  if (contextId) {
    // 只删一条 context
    db.delete(contexts).where(eq(contexts.id, contextId)).run();
    return NextResponse.json({ ok: true });
  }

  // 验证归属
  const word = db
    .select()
    .from(userWords)
    .where(eq(userWords.id, id))
    .get() as typeof userWords.$inferSelect | undefined;

  if (!word) {
    return NextResponse.json({ error: "词条不存在" }, { status: 404 });
  }

  if (word.userId !== LOCAL_USER) {
    return NextResponse.json({ error: "无权操作" }, { status: 403 });
  }

  db.transaction((tx) => {
    // contexts 设了 onDelete: cascade，但 better-sqlite3 可能不触发
    // 所以显式删
    tx.delete(contexts).where(eq(contexts.userWordId, id)).run();
    tx.delete(userWords).where(eq(userWords.id, id)).run();
  });

  return NextResponse.json({ ok: true });
}

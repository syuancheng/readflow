import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userWords, contexts, LOCAL_USER } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/words/[id]
 * 更新词条状态（对齐 Readlang 的词表操作）：
 *   { status: "learning" | "learned" | "deleted" }   —— 移出词库 = 软删除，可恢复
 *   { starred: 0 | 1 }                               —— 星标
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { status?: string; starred?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

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

  const updates: Partial<typeof userWords.$inferInsert> = {};
  if (body.status && ["learning", "learned", "deleted"].includes(body.status)) {
    updates.status = body.status;
  }
  if (typeof body.starred === "number") {
    updates.starred = body.starred ? 1 : 0;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
  }

  db.update(userWords).set(updates).where(eq(userWords.id, id)).run();
  return NextResponse.json({ ok: true, ...updates });
}

/**
 * DELETE /api/words/[id]
 * 删除一个词：同时删 user_words 和它关联的 contexts。
 * 如果带 ?contextId=xxx，只删那一条 context，不删词本身。
 *
 * 注意：词库 UI 里的"移出词库"走 PATCH status=deleted（软删除），
 * 保留 exports 记录保证墨墨导出幂等；这个硬删除只用于彻底清掉错词。
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

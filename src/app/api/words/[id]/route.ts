import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userWords, contexts, exports } from "@/db/schema";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/words/[id]
 * 更新词条状态（对齐 Readlang 的词表操作）：
 *   { status: "learning" | "learned" }   —— 标记学习状态
 *   { starred: 0 | 1 }                   —— 星标
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
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
  if (word.userId !== user.id) {
    return NextResponse.json({ error: "无权操作" }, { status: 403 });
  }

  const updates: Partial<typeof userWords.$inferInsert> = {};
  if (body.status && ["learning", "learned"].includes(body.status)) {
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
 * 删除一个词：同时删 user_words、它关联的 contexts 和 exports 记录。
 * 如果带 ?contextId=xxx，只删那一条 context，不删词本身。
 *
 * 删除一律彻底删除——删除即代表用户已掌握这个词，不留「已移出」的中间态；
 * 下次再查到这个词就当新词重新收。
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { id } = await params;
  const url = new URL(req.url);
  const contextId = url.searchParams.get("contextId");
  const textId = url.searchParams.get("textId");

  if (contextId || textId) {
    // 删 context（?contextId= 一条；?textId= 该文本下这个词的全部——
    // 批注按词去重后，× 的语义是「清掉这个词在本文的标记」，
    // 只删最新一条会让更早的 context 重新浮出来）。
    // 删完后这个词条已经没有任何 context 了，就把词条一并删掉（见下）。
    const word = db
      .select()
      .from(userWords)
      .where(eq(userWords.id, id))
      .get() as typeof userWords.$inferSelect | undefined;

    if (!word) {
      return NextResponse.json({ error: "词条不存在" }, { status: 404 });
    }
    if (word.userId !== user.id) {
      return NextResponse.json({ error: "无权操作" }, { status: 403 });
    }

    if (textId) {
      db.delete(contexts)
        .where(and(eq(contexts.userWordId, id), eq(contexts.textId, textId)))
        .run();
    } else {
      // 必须同时限定 userWordId：只校验了词条归属，contextId 却是客户端随便填的
      db.delete(contexts)
        .where(and(eq(contexts.id, contextId!), eq(contexts.userWordId, id)))
        .run();
    }

    const remaining = db
      .select({ id: contexts.id })
      .from(contexts)
      .where(eq(contexts.userWordId, id))
      .all();

    // 「取消记录」（P25）只删这篇文章里的这一处；这个词别处已经没有任何记录时，
    // 连词条一起删掉 —— 否则词库和墨墨导出里会留下一个没有原句的空词条。
    if (remaining.length === 0) {
      db.transaction((tx) => {
        tx.delete(exports).where(eq(exports.userWordId, id)).run();
        tx.delete(userWords).where(eq(userWords.id, id)).run();
      });
      return NextResponse.json({ ok: true, prunedWord: true });
    }

    return NextResponse.json({ ok: true, prunedWord: false });
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

  if (word.userId !== user.id) {
    return NextResponse.json({ error: "无权操作" }, { status: 403 });
  }

  db.transaction((tx) => {
    // contexts 设了 onDelete: cascade，但 better-sqlite3 可能不触发，
    // 所以显式删；exports 一并清掉——词条都没了，导出去重记录没有意义
    tx.delete(contexts).where(eq(contexts.userWordId, id)).run();
    tx.delete(exports).where(eq(exports.userWordId, id)).run();
    tx.delete(userWords).where(eq(userWords.id, id)).run();
  });

  return NextResponse.json({ ok: true });
}

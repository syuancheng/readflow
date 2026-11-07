import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { paragraphs, texts } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const [text] = await db.select().from(texts).where(eq(texts.id, id)).limit(1);
  if (!text) return NextResponse.json({ error: "文本不存在" }, { status: 404 });

  const rows = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.textId, id))
    .orderBy(asc(paragraphs.idx));

  return NextResponse.json({ text, paragraphs: rows });
}

/**
 * DELETE /api/texts/{id}
 *
 * 删除语义（必须保持，前端确认弹窗与词库页都依赖它）：
 *   - 删：texts + paragraphs（外键级联）+ section_summaries（外键级联）
 *   - 留：user_words / contexts / exports —— 阅读时收的词、原句、AI 释义
 *     是用户资产，不随文章消失；contexts 对 texts 没有外键，天然保留。
 *     词库页用 leftJoin 展示，文章删了显示「来自已删除的文章」。
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await db.delete(texts).where(eq(texts.id, id));
  return NextResponse.json({ ok: true });
}

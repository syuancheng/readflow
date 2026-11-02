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

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await db.delete(texts).where(eq(texts.id, id));
  return NextResponse.json({ ok: true });
}

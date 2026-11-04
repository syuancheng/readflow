import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contexts, userWords, paragraphs } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/annotations?textId=xxx
 *
 * 列出某篇文章里「拖选保存的句子/短语批注」，按时间倒序。
 * 数据来自 contexts（本来就有段落偏移 + 前后文 + AI 释义），不新增表。
 * 只保留选区含空格的条目（点词自动收的单词不算批注），并排除已移出词库的词条。
 */
export async function GET(req: Request) {
  const textId = new URL(req.url).searchParams.get("textId");
  if (!textId) {
    return NextResponse.json({ error: "textId is required" }, { status: 400 });
  }

  const rows = db
    .select({
      id: contexts.id,
      wordId: contexts.userWordId,
      paragraphId: contexts.paragraphId,
      paragraphIdx: paragraphs.idx,
      start: contexts.start,
      end: contexts.end,
      quote: contexts.quote,
      prefix: contexts.prefix,
      suffix: contexts.suffix,
      aiGloss: contexts.aiGloss,
      createdAt: contexts.createdAt,
      wordStatus: userWords.status,
    })
    .from(contexts)
    .innerJoin(userWords, eq(userWords.id, contexts.userWordId))
    .innerJoin(paragraphs, eq(paragraphs.id, contexts.paragraphId))
    .where(eq(contexts.textId, textId))
    .orderBy(desc(contexts.createdAt))
    .all();

  const annotations = rows
    .filter((r) => /\s/.test(r.quote.trim()) && r.wordStatus !== "deleted")
    .map(({ wordStatus: _status, ...r }) => r);

  return NextResponse.json({ annotations });
}

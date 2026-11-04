import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contexts, userWords, paragraphs } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/annotations?textId=xxx
 *
 * 列出某篇文章里保存过的批注（单词点查 + 句子/短语拖选都算），按时间倒序。
 * 数据来自 contexts（本来就有段落偏移 + 前后文 + AI 释义），不新增表。
 * 排除已移出词库的词条。
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

  // 单词与句子/短语一视同仁：点词自动收的 context 也返回，
  // 让「那次被查的出现」获得持久高亮标记（w-annotated），并进回看列表。
  // 只排除已移出词库的词条。
  //
  // 按词条去重，每个词只保留最近一条 context：
  // 同一个词可能在多处被反复查过（删词再收、短语重划都会补 context），
  // 但标记的语义是「这个词我是在哪里查的」——一处就够，不该全文开花。
  const seen = new Set<string>();
  const annotations = rows
    .filter((r) => r.wordStatus !== "deleted")
    .filter((r) => {
      if (seen.has(r.wordId)) return false;
      seen.add(r.wordId);
      return true;
    })
    .map(({ wordStatus: _status, ...r }) => r);

  return NextResponse.json({ annotations });
}

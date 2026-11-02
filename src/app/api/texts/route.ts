import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { paragraphs, texts, LOCAL_USER } from "@/db/schema";
import { splitParagraphs, countWords } from "@/lib/split";
import { extractFromUrl } from "@/lib/readability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db
    .select()
    .from(texts)
    .where(eq(texts.userId, LOCAL_USER))
    .orderBy(desc(texts.createdAt));
  return NextResponse.json({ texts: rows });
}

export async function POST(req: Request) {
  let body: { title?: string; text?: string; url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const url = body.url?.trim();
  const rawText = body.text ?? "";

  let title = body.title?.trim() || "";
  let content = rawText;
  let sourceType: "paste" | "file" | "url" = "paste";

  if (url) {
    sourceType = "url";
    try {
      const extracted = await extractFromUrl(url);
      content = extracted.text;
      title = title || extracted.title;
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 });
    }
  }

  const parts = splitParagraphs(content);
  if (parts.length === 0) {
    return NextResponse.json({ error: "正文为空，没有可阅读的内容" }, { status: 400 });
  }

  if (!title) {
    title = parts[0].slice(0, 40) + (parts[0].length > 40 ? "…" : "");
  }

  const textId = randomUUID();
  const now = Date.now();
  const wordCount = countWords(parts.join(" "));

  // better-sqlite3 是同步驱动，事务回调不能返回 Promise
  db.transaction((tx) => {
    tx.insert(texts)
      .values({
        id: textId,
        userId: LOCAL_USER,
        title,
        sourceType,
        sourceUrl: url || null,
        language: "en",
        wordCount,
        createdAt: now,
      })
      .run();

    tx.insert(paragraphs)
      .values(
        parts.map((content, idx) => ({
          id: randomUUID(),
          textId,
          idx,
          content,
        })),
      )
      .run();
  });

  return NextResponse.json({ id: textId, title, paragraphCount: parts.length, wordCount });
}

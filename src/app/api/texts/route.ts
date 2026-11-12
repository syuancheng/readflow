import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { texts } from "@/db/schema";
import { extractFromUrl } from "@/lib/readability";
import { parsePasted } from "@/lib/import";
import type { Block, ImportFormatChoice, SourceFormat } from "@/lib/import/types";
import { currentUser } from "@/lib/auth";
import { blocksFromExtracted, createText, EmptyTextError } from "@/lib/create-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const rows = await db
    .select()
    .from(texts)
    .where(eq(texts.userId, user.id))
    .orderBy(desc(texts.createdAt));
  return NextResponse.json({ texts: rows });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  let body: {
    title?: string;
    text?: string;
    url?: string;
    format?: ImportFormatChoice;
    sourceType?: "paste" | "file";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const url = body.url?.trim();
  const rawText = body.text ?? "";
  const choice: ImportFormatChoice =
    body.format === "plain" || body.format === "markdown" ? body.format : "auto";

  let title = body.title?.trim() || "";
  let sourceType: "paste" | "file" | "url" = body.sourceType === "file" ? "file" : "paste";
  let blocks: Block[];
  let sourceFormat: SourceFormat;
  let sourceRaw: string;

  if (url) {
    sourceType = "url";
    try {
      const extracted = await extractFromUrl(url);
      ({ blocks, sourceFormat, sourceRaw } = blocksFromExtracted(extracted, url));
      title = title || extracted.title;
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 });
    }
  } else {
    const parsed = parsePasted(rawText, choice);
    blocks = parsed.blocks;
    sourceFormat = parsed.format;
    sourceRaw = rawText;
  }

  try {
    const created = createText({
      userId: user.id,
      title,
      sourceType,
      sourceUrl: url || null,
      blocks,
      sourceFormat,
      sourceRaw,
    });
    return NextResponse.json(created);
  } catch (e) {
    if (e instanceof EmptyTextError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

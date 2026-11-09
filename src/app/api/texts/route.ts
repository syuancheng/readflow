import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { paragraphs, texts } from "@/db/schema";
import { countWords } from "@/lib/split";
import { extractFromUrl } from "@/lib/readability";
import { estimateCefrForParts } from "@/lib/cefr-dict";
import {
  parsePasted,
  parseMarkdown,
  parseHtmlBlocks,
  pruneBlocks,
  proseTexts,
  kindCounts,
} from "@/lib/import";
import type { Block, ImportFormatChoice, SourceFormat } from "@/lib/import/types";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** source_raw 只用于将来重解析，超大文本没必要把 SQLite 撑爆。 */
const MAX_SOURCE_RAW = 2 * 1024 * 1024;

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
      if (extracted.markdown) {
        // 站点的官方 Markdown 是保真度最高的源，直接进 Markdown 适配器；
        // baseUrl 用来把 /img/a.png 这类相对图片解析成绝对地址
        blocks = parseMarkdown(extracted.markdown, url);
        sourceFormat = "markdown";
        sourceRaw = extracted.markdown;
      } else {
        blocks = parseHtmlBlocks(extracted.html ?? "", url);
        sourceFormat = "html";
        sourceRaw = extracted.html ?? "";
      }
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

  blocks = pruneBlocks(blocks);
  if (blocks.length === 0) {
    return NextResponse.json({ error: "正文为空，没有可阅读的内容" }, { status: 400 });
  }

  if (!title) {
    const first = blocks.find((b) => b.text.trim())?.text ?? "";
    title = first.slice(0, 40) + (first.length > 40 ? "…" : "");
  }

  const textId = randomUUID();
  const now = Date.now();

  // 词数 / CEFR / 分段小结只吃自然语言正文：
  // 代码里的 pnpm、json、__init__ 会把词频和难度估得一塌糊涂。
  const parts = proseTexts(blocks);
  const wordCount = countWords(parts.join(" "));

  // 对齐 Readlang：难度在导入时由服务端算一次并落库，前端只负责展示。
  // 放在事务外：它读的是只读的 ECDICT 词典库，且失败必须允许导入继续。
  const cefr = estimateCefrForParts(parts);

  const rawToStore = sourceRaw.length > MAX_SOURCE_RAW ? null : sourceRaw;

  // better-sqlite3 是同步驱动，事务回调不能返回 Promise
  db.transaction((tx) => {
    tx.insert(texts)
      .values({
        id: textId,
        userId: user.id,
        title,
        sourceType,
        sourceUrl: url || null,
        language: "en",
        wordCount,
        createdAt: now,
        cefrLevel: cefr?.level ?? null,
        cefrScore: cefr?.score ?? null,
        cefrDetail: cefr ? JSON.stringify(cefr.detail) : null,
        cefrMethod: cefr?.method ?? null,
        sourceFormat,
        sourceRaw: rawToStore,
      })
      .run();

    tx.insert(paragraphs)
      .values(
        blocks.map((b, idx) => ({
          id: randomUUID(),
          textId,
          idx,
          content: b.text,
          blockType: b.kind,
          blockMeta: JSON.stringify(b.meta),
          inlineRanges: JSON.stringify(b.ranges),
        })),
      )
      .run();
  });

  return NextResponse.json({
    id: textId,
    title,
    paragraphCount: blocks.length,
    wordCount,
    sourceFormat,
    blockKinds: kindCounts(blocks),
    cefrLevel: cefr?.level ?? null,
    cefrScore: cefr?.score ?? null,
    cefrConfidence: cefr?.confidence ?? null,
  });
}

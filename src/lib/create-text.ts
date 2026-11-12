/**
 * 「正文块 → 一篇文章」的落库逻辑（P30 从 /api/texts 抽出）。
 *
 * 粘贴 / 上传 / URL 导入（/api/texts）和插件导入（/api/extension/import）共用这一份：
 * 同样的空段过滤、标题兜底、词数与 CEFR 估算、同一个事务写 texts + paragraphs。
 * 只要正文块一样，两条路径落库的结果就一样。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { paragraphs, texts } from "@/db/schema";
import { countWords } from "@/lib/split";
import { estimateCefrForParts } from "@/lib/cefr-dict";
import { parseHtmlBlocks, parseMarkdown, pruneBlocks, proseTexts, kindCounts } from "@/lib/import";
import type { Block, SourceFormat } from "@/lib/import/types";
import type { Extracted } from "@/lib/readability";

/** source_raw 只用于将来重解析，超大文本没必要把 SQLite 撑爆。 */
const MAX_SOURCE_RAW = 2 * 1024 * 1024;

export class EmptyTextError extends Error {
  constructor() {
    super("正文为空，没有可阅读的内容");
  }
}

/** 网页提取结果 → 正文块：官方 Markdown 优先，否则解析 Readability 的 HTML */
export function blocksFromExtracted(
  extracted: Extracted,
  url: string,
): { blocks: Block[]; sourceFormat: SourceFormat; sourceRaw: string } {
  if (extracted.markdown) {
    // baseUrl 用来把 /img/a.png 这类相对图片解析成绝对地址
    return { blocks: parseMarkdown(extracted.markdown, url), sourceFormat: "markdown", sourceRaw: extracted.markdown };
  }
  const html = extracted.html ?? "";
  return { blocks: parseHtmlBlocks(html, url), sourceFormat: "html", sourceRaw: html };
}

export type CreateTextInput = {
  userId: string;
  title: string;
  sourceType: "paste" | "file" | "url";
  sourceUrl: string | null;
  blocks: Block[];
  sourceFormat: SourceFormat;
  sourceRaw: string;
};

export type CreatedText = {
  id: string;
  title: string;
  paragraphCount: number;
  wordCount: number;
  sourceFormat: SourceFormat;
  blockKinds: ReturnType<typeof kindCounts>;
  cefrLevel: string | null;
  cefrScore: number | null;
  cefrConfidence: string | null;
};

/** 写入一篇文章；正文过滤后为空时抛 EmptyTextError */
export function createText(input: CreateTextInput): CreatedText {
  const blocks = pruneBlocks(input.blocks);
  if (blocks.length === 0) throw new EmptyTextError();

  let title = input.title.trim();
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

  const rawToStore = input.sourceRaw.length > MAX_SOURCE_RAW ? null : input.sourceRaw;

  // better-sqlite3 是同步驱动，事务回调不能返回 Promise
  db.transaction((tx) => {
    tx.insert(texts)
      .values({
        id: textId,
        userId: input.userId,
        title,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        language: "en",
        wordCount,
        createdAt: now,
        cefrLevel: cefr?.level ?? null,
        cefrScore: cefr?.score ?? null,
        cefrDetail: cefr ? JSON.stringify(cefr.detail) : null,
        cefrMethod: cefr?.method ?? null,
        sourceFormat: input.sourceFormat,
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

  return {
    id: textId,
    title,
    paragraphCount: blocks.length,
    wordCount,
    sourceFormat: input.sourceFormat,
    blockKinds: kindCounts(blocks),
    cefrLevel: cefr?.level ?? null,
    cefrScore: cefr?.score ?? null,
    cefrConfidence: cefr?.confidence ?? null,
  };
}

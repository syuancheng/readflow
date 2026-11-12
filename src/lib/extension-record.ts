/**
 * 插件查词的落库与回看（P31）。
 *
 * 路由文件只能导出 GET/POST 等固定名字，所以把逻辑放在这里：
 * - `recordFromWeb`：点词自动记录（对应网站的 /api/contexts/ensure）
 * - `recallWord`：点已存词的高亮时只读回看
 *
 * 与阅读页的关系：锚点、词典、信号、要不要自动讲解全部复用网站同一套函数，
 * 插件不自己实现任何一份规则。
 */
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { contexts, paragraphs, texts, userWords } from "@/db/schema";
import { lookup } from "@/lib/dict";
import { parseThread } from "@/lib/ai-thread";
import { shouldAutoExplain } from "@/lib/explain-policy";
import { aiContextOf, selectionSignals } from "@/lib/sentence";
import { buildAnchor } from "@/lib/tokenize";
import { ensureContextByAnchor } from "@/lib/word-store";
import { locateInParagraphs, normalizeBlockText, stripHash } from "@/lib/web-anchor";

export type ExtensionSource = "word" | "select";

export type RecordInput = {
  word: string;
  block: string;
  start: number;
  end: number;
  url: string;
  title: string;
  source: ExtensionSource;
  repeatCount: number;
};

export type ExtensionPayload = {
  ok: true;
  wordId: string;
  contextId: string;
  textId: string;
  paragraphId: string;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  dict: { entry: unknown; originalForm: string; lemmaForm: string };
  thread: { ask?: string; text: string }[];
  autoExplain: boolean;
  aiContext: { prefix: string; suffix: string; withPrevSentence: boolean };
  signals: Record<string, unknown>;
  imported: boolean;
};

type ParaRow = { id: string; content: string; idx: number };

function safeLookup(word: string) {
  try {
    return lookup(word);
  } catch {
    // 词典库没导入时照样能记录，只是没有词典释义
    return { entry: null, originalForm: word, lemmaForm: word };
  }
}

function paragraphsOf(textId: string): ParaRow[] {
  return db
    .select({ id: paragraphs.id, content: paragraphs.content, idx: paragraphs.idx })
    .from(paragraphs)
    .where(eq(paragraphs.textId, textId))
    .orderBy(paragraphs.idx)
    .all();
}

/** 同一篇文章里的上一段（跨段取「上一句」用） */
function previousOf(list: ParaRow[], paragraphId: string): string | undefined {
  const at = list.findIndex((p) => p.id === paragraphId);
  return at > 0 ? list[at - 1].content : undefined;
}

/**
 * 决策 D3 第一步：这个网址有没有被同一个人整篇导入过。
 * 有就用那篇文章的段落坐标；没定位到就退回「网页摘录」。
 */
function findImportedTextId(userId: string, url: string): string | null {
  const rows = db
    .select({ id: texts.id, sourceUrl: texts.sourceUrl })
    .from(texts)
    .where(and(eq(texts.userId, userId), eq(texts.sourceType, "url")))
    .orderBy(desc(texts.createdAt))
    .all();
  for (const r of rows) {
    if (r.sourceUrl && stripHash(r.sourceUrl) === url) return r.id;
  }
  return null;
}

/** 这个网址的「网页摘录」（source_type='web'）；没有就建一条 */
function ensureExcerpt(userId: string, url: string, title: string): string {
  const existing = db
    .select({ id: texts.id })
    .from(texts)
    .where(and(eq(texts.userId, userId), eq(texts.sourceUrl, url), eq(texts.sourceType, "web")))
    .orderBy(desc(texts.createdAt))
    .get();
  if (existing) return existing.id;

  const id = randomUUID();
  db.insert(texts)
    .values({
      id,
      userId,
      title: title || url || "网页摘录",
      sourceType: "web",
      sourceUrl: url,
      language: "en",
      wordCount: 0,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

/** 摘录里放这个块的段落：能复用就复用，没有才追加（idx = 当前最大值 +1） */
function ensureExcerptParagraph(
  textId: string,
  block: string,
  word: string,
  start: number,
  end: number,
): { paragraphId: string; start: number; end: number } {
  const list = paragraphsOf(textId);

  const exact = list.find((p) => p.content === block);
  if (exact) return { paragraphId: exact.id, start, end };

  const normBlock = normalizeBlockText(block);
  const same = list.find((p) => normalizeBlockText(p.content) === normBlock);
  if (same) {
    const loc = locateInParagraphs([{ id: same.id, content: same.content }], block, start, end);
    if (loc) return { paragraphId: same.id, start: loc.start, end: loc.end };
  }

  const paragraphId = randomUUID();
  db.insert(paragraphs)
    .values({
      id: paragraphId,
      textId,
      idx: list.length > 0 ? Math.max(...list.map((p) => p.idx)) + 1 : 0,
      content: block,
      blockType: "paragraph",
    })
    .run();
  // 整块就是原文，请求里的坐标可以直接用（block.slice(start,end) === word 已校验）
  void word;
  return { paragraphId, start, end };
}

/**
 * 点词自动记录。
 *
 * 顺序与网站一致：定位段落 → 生成锚点 → 幂等入库 → 查词典 → 判断要不要
 * 自动讲解 → 采集信号。返回给插件的数据足够它直接渲染侧栏和发起追问。
 */
export function recordFromWeb(userId: string, input: RecordInput): ExtensionPayload {
  const url = stripHash(input.url);
  const source: ExtensionSource = input.source === "select" ? "select" : "word";

  // 1. 决定锚点挂在哪篇文章上（D3）
  let textId: string | null = null;
  let paragraphId = "";
  let start = input.start;
  let end = input.end;
  let imported = false;

  const importedTextId = findImportedTextId(userId, url);
  if (importedTextId) {
    const list = paragraphsOf(importedTextId);
    const loc = locateInParagraphs(list, input.block, input.start, input.end);
    if (loc) {
      textId = importedTextId;
      paragraphId = loc.paragraphId;
      start = loc.start;
      end = loc.end;
      imported = true;
    }
  }

  if (!textId) {
    textId = ensureExcerpt(userId, url, input.title);
    const placed = ensureExcerptParagraph(textId, input.block, input.word, input.start, input.end);
    paragraphId = placed.paragraphId;
    start = placed.start;
    end = placed.end;
  }

  const list = paragraphsOf(textId);
  const paragraph = list.find((p) => p.id === paragraphId);
  if (!paragraph) throw new Error("段落不存在");

  // 2. 锚点用段落原文生成，保证与阅读页同一坐标基准
  const anchor = buildAnchor(paragraph.content, start, end);
  const saved = ensureContextByAnchor(
    {
      word: input.word,
      textId,
      paragraphId,
      start: anchor.start,
      end: anchor.end,
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      via: "extension",
    },
    userId,
  );

  // 3. 词典 + 已有对话串
  const dict = safeLookup(input.word);
  const ctx = db.select().from(contexts).where(eq(contexts.id, saved.contextId)).get();
  const aiGloss = ctx?.aiGloss ?? null;
  const thread = parseThread(aiGloss);

  // 4. 要不要自动讲解：只在服务端判断，插件照结果执行
  const autoExplain = shouldAutoExplain({
    dictHit: Boolean(dict.entry),
    hasInitialGloss: Boolean(aiGloss),
    fromAnnotation: false,
    repeatCount: input.repeatCount,
  });

  // 5. 信号（同阅读页）与发给 AI 的前后文
  const signals = {
    ...selectionSignals(paragraph.content, anchor.start, anchor.end, source),
    repeatCount: input.repeatCount,
    dictHit: Boolean(dict.entry),
  };
  const aiContext = aiContextOf(paragraph.content, anchor.start, anchor.end, {
    prevParagraph: previousOf(list, paragraphId),
  });

  return {
    ok: true,
    wordId: saved.wordId,
    contextId: saved.contextId,
    textId,
    paragraphId,
    start: anchor.start,
    end: anchor.end,
    quote: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    dict: { entry: dict.entry, originalForm: dict.originalForm, lemmaForm: dict.lemmaForm },
    thread: thread.map((t) => ({ ...(t.ask ? { ask: t.ask } : {}), text: t.text })),
    autoExplain,
    aiContext: {
      prefix: aiContext.prefix,
      suffix: aiContext.suffix,
      withPrevSentence: aiContext.withPrevSentence === true,
    },
    signals,
    imported,
  };
}

/** 点已存词的高亮：只读回看，不查词典、不调 AI、不自动讲解 */
export function recallWord(
  userId: string,
  wordId: string,
): { ok: true; payload: ExtensionPayload } | { ok: false; reason: "not_found" } {
  const word = db.select().from(userWords).where(eq(userWords.id, wordId)).get();
  if (!word || word.userId !== userId) return { ok: false, reason: "not_found" };

  const ctx = db
    .select()
    .from(contexts)
    .where(eq(contexts.userWordId, wordId))
    .orderBy(desc(contexts.createdAt))
    .limit(1)
    .get();
  if (!ctx) return { ok: false, reason: "not_found" };

  const text = db.select().from(texts).where(eq(texts.id, ctx.textId)).get();
  const list = paragraphsOf(ctx.textId);
  const paragraph = list.find((p) => p.id === ctx.paragraphId);
  const content = paragraph?.content ?? "";

  // 词典用查词当时的快照，不再查一次
  let dict: { entry: unknown; originalForm: string; lemmaForm: string } = {
    entry: null,
    originalForm: ctx.quote,
    lemmaForm: word.lemma,
  };
  if (ctx.dictEntry) {
    try {
      const snap = JSON.parse(ctx.dictEntry) as {
        entry?: unknown;
        originalForm?: string;
        lemmaForm?: string;
      };
      dict = {
        entry: snap.entry ?? null,
        originalForm: snap.originalForm ?? ctx.quote,
        lemmaForm: snap.lemmaForm ?? word.lemma,
      };
    } catch {
      /* 快照坏了就用兜底 */
    }
  }

  const thread = parseThread(ctx.aiGloss);
  const aiContext = aiContextOf(content, ctx.start, ctx.end, {
    prevParagraph: paragraph ? previousOf(list, paragraph.id) : undefined,
  });

  return {
    ok: true,
    payload: {
      ok: true,
      wordId,
      contextId: ctx.id,
      textId: ctx.textId,
      paragraphId: ctx.paragraphId,
      start: ctx.start,
      end: ctx.end,
      quote: ctx.quote,
      prefix: ctx.prefix,
      suffix: ctx.suffix,
      dict,
      thread: thread.map((t) => ({ ...(t.ask ? { ask: t.ask } : {}), text: t.text })),
      autoExplain: false,
      aiContext: {
        prefix: aiContext.prefix,
        suffix: aiContext.suffix,
        withPrevSentence: aiContext.withPrevSentence === true,
      },
      signals: selectionSignals(content, ctx.start, ctx.end, "word"),
      imported: text?.sourceType === "url",
    },
  };
}

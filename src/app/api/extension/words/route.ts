import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { desc, eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { contexts, paragraphs, texts, userWords, LOCAL_USER } from "@/db/schema";
import { SETTINGS_KEYS } from "@/lib/config";
import { getSetting } from "@/lib/settings-store";
import { shortGloss } from "@/lib/gloss";
import { lookup } from "@/lib/dict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 扩展插件从 chrome-extension:// 发请求，带自定义头会触发预检 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-readflow-token, Authorization",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function authorized(req: Request): boolean {
  const expected = getSetting(SETTINGS_KEYS.extensionToken);
  if (!expected) return false;
  const header = req.headers.get("x-readflow-token") ?? "";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const got = header || bearer;
  if (!got || got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * GET /api/extension/words
 * 插件词表同步。Token 在 ReadFlow → 头像 → 设置 → 浏览器插件 里生成。
 */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return withCors(
      NextResponse.json(
        { ok: false, error: "插件 Token 无效或尚未生成，请在 ReadFlow 设置页生成并填入插件" },
        { status: 401 },
      ),
    );
  }

  const rows = db
    .select({
      id: userWords.id,
      lemma: userWords.lemma,
      displayForm: userWords.displayForm,
      phonetic: userWords.phonetic,
      pos: userWords.pos,
      translation: userWords.translation,
      isPhrase: userWords.isPhrase,
      createdAt: userWords.createdAt,
    })
    .from(userWords)
    .where(eq(userWords.userId, LOCAL_USER))
    .orderBy(desc(userWords.createdAt))
    .all();

  // 每个词带一句最近查过的原文，插件卡片里显示语境
  const examples = db
    .select({
      userWordId: contexts.userWordId,
      sentence: sql<string>`(${contexts.prefix} || ${contexts.quote} || ${contexts.suffix})`,
      createdAt: contexts.createdAt,
    })
    .from(contexts)
    .orderBy(desc(contexts.createdAt))
    .all();
  const exampleByWord = new Map<string, string>();
  for (const e of examples) {
    if (!exampleByWord.has(e.userWordId)) {
      exampleByWord.set(e.userWordId, String(e.sentence ?? "").replace(/\s+/g, " ").trim().slice(0, 220));
    }
  }

  return withCors(
    NextResponse.json({
      ok: true,
      generatedAt: Date.now(),
      words: rows.map((w) => ({
        id: w.id,
        lemma: w.lemma,
        displayForm: w.displayForm,
        phonetic: w.phonetic,
        pos: w.pos,
        translation: w.translation,
        gloss: shortGloss(w.translation),
        isPhrase: w.isPhrase === 1,
        example: exampleByWord.get(w.id) ?? "",
      })),
    }),
  );
}

type SaveBody = {
  word?: string;
  sentence?: string;
  url?: string;
  title?: string;
  translation?: string;
};

/**
 * POST /api/extension/words
 * 网页上划词收进词库：为该网页建一条轻量文本 + 段落，再走与主站一致的 upsert 逻辑。
 */
export async function POST(req: Request) {
  if (!authorized(req)) {
    return withCors(NextResponse.json({ ok: false, error: "插件 Token 无效" }, { status: 401 }));
  }

  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return withCors(NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 }));
  }

  const word = body.word?.trim();
  if (!word || word.length > 120) {
    return withCors(NextResponse.json({ ok: false, error: "缺少要收藏的词" }, { status: 400 }));
  }
  const sentence = (body.sentence ?? word).trim().slice(0, 600) || word;
  const url = (body.url ?? "").trim().slice(0, 500);
  const title = (body.title ?? url ?? "网页摘录").trim().slice(0, 200) || "网页摘录";

  let dictResult: ReturnType<typeof lookup> = { entry: null, originalForm: word, lemmaForm: word };
  try {
    dictResult = lookup(word);
  } catch {
    /* 词典库没导入时照样能收词，用网页上给的释义兜底 */
  }
  const lemmaForm = dictResult.lemmaForm || word;
  const translation =
    dictResult.entry?.translation ?? body.translation?.trim() ?? "(待补充释义)";
  const phonetic = dictResult.entry?.phonetic ?? null;
  const pos = dictResult.entry?.pos ?? null;
  const isPhrase = /\s/.test(word) ? 1 : 0;
  const now = Date.now();

  const result = db.transaction((tx) => {
    // 同一个网页复用一条 text（避免每收一个词就多一篇文章）
    let text = url
      ? tx.select().from(texts).where(eq(texts.sourceUrl, url)).get()
      : undefined;
    if (!text) {
      const id = randomUUID();
      tx.insert(texts)
        .values({
          id,
          userId: LOCAL_USER,
          title,
          sourceType: "web",
          sourceUrl: url || null,
          language: "en",
          wordCount: sentence.split(/\s+/).length,
          createdAt: now,
        })
        .run();
      text = tx.select().from(texts).where(eq(texts.id, id)).get();
    }

    const paraCount = tx
      .select({ c: sql<number>`count(*)` })
      .from(paragraphs)
      .where(eq(paragraphs.textId, text!.id))
      .get();
    const paragraphId = randomUUID();
    tx.insert(paragraphs)
      .values({ id: paragraphId, textId: text!.id, idx: Number(paraCount?.c ?? 0), content: sentence })
      .run();

    let existing = tx.select().from(userWords).where(eq(userWords.lemma, lemmaForm)).get();
    let wordId: string;
    if (existing) {
      wordId = existing.id;
      tx.update(userWords)
        .set({
          displayForm: word,
          phonetic: phonetic ?? existing.phonetic,
          pos: pos ?? existing.pos,
          isPhrase,
        })
        .where(eq(userWords.id, wordId))
        .run();
    } else {
      wordId = randomUUID();
      tx.insert(userWords)
        .values({
          id: wordId,
          userId: LOCAL_USER,
          lemma: lemmaForm,
          displayForm: word,
          pos,
          phonetic,
          translation,
          note: null,
          createdAt: now,
          isPhrase,
        })
        .run();
    }

    // 同一个词在同一句里已经收过就不重复建 context
    const dup = tx
      .select({ id: contexts.id })
      .from(contexts)
      .where(and(eq(contexts.userWordId, wordId), eq(contexts.quote, word), eq(contexts.textId, text!.id)))
      .get();
    if (!dup) {
      const start = sentence.toLowerCase().indexOf(word.toLowerCase());
      const s = start >= 0 ? start : 0;
      const e = start >= 0 ? start + word.length : sentence.length;
      tx.insert(contexts)
        .values({
          id: randomUUID(),
          userWordId: wordId,
          textId: text!.id,
          paragraphId,
          start: s,
          end: e,
          quote: word,
          // 坐标已在句内：前后文直接给到句首/句尾，不从词中间截断
          prefix: sentence.slice(0, s),
          suffix: sentence.slice(e),
          createdAt: now,
        })
        .run();
    }

    return { wordId, translation, phonetic, pos, duplicate: Boolean(dup) };
  });

  return withCors(
    NextResponse.json({
      ok: true,
      wordId: result.wordId,
      lemma: lemmaForm,
      gloss: shortGloss(result.translation),
      duplicate: result.duplicate,
    }),
  );
}

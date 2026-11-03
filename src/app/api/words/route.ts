import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { userWords, contexts, texts, paragraphs, LOCAL_USER } from "@/db/schema";
import { lookup } from "@/lib/dict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/words
 * 列出当前用户的所有收词，按时间倒序。
 * 可选 ?textId=xxx 只列某篇文章里收的词。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const textId = url.searchParams.get("textId");

  if (textId) {
    // 查某篇文章里收的词（通过 contexts 关联）
    const rows = db
      .select({
        id: userWords.id,
        lemma: userWords.lemma,
        displayForm: userWords.displayForm,
        pos: userWords.pos,
        phonetic: userWords.phonetic,
        translation: userWords.translation,
        note: userWords.note,
        createdAt: userWords.createdAt,
      })
      .from(userWords)
      .innerJoin(contexts, eq(contexts.userWordId, userWords.id))
      .where(eq(contexts.textId, textId))
      .orderBy(desc(userWords.createdAt))
      .all();
    return NextResponse.json({ words: dedup(rows) });
  }

  const rows = db
    .select()
    .from(userWords)
    .where(eq(userWords.userId, LOCAL_USER))
    .orderBy(desc(userWords.createdAt))
    .all();

  return NextResponse.json({ words: rows });
}

function dedup<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

/**
 * POST /api/words
 * 收词：写入 user_words（按 lemma 去重 upsert）+ contexts（每次一条）。
 *
 * Body:
 *   word:       用户选中的原文（如 "rained" 或 "river bank"）
 *   textId:     所在文本 id
 *   paragraphId: 所在段落 id
 *   start/end:  段内字符偏移
 *   quote:      选中文字
 *   prefix:     前文
 *   suffix:     后文
 *   aiGloss?:   AI 释义文本（如有）
 */
export async function POST(req: Request) {
  let body: {
    word: string;
    textId: string;
    paragraphId: string;
    start: number;
    end: number;
    quote: string;
    prefix: string;
    suffix: string;
    aiGloss?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const { word, textId, paragraphId, start, end, quote, prefix, suffix, aiGloss } = body;

  if (!word?.trim() || !textId || !paragraphId || !quote) {
    return NextResponse.json({ error: "缺少必填字段" }, { status: 400 });
  }

  // 验证 textId 和 paragraphId 存在
  const text = db.select().from(texts).where(eq(texts.id, textId)).get();
  if (!text) {
    return NextResponse.json({ error: "文本不存在" }, { status: 404 });
  }

  const para = db.select().from(paragraphs).where(eq(paragraphs.id, paragraphId)).get();
  if (!para) {
    return NextResponse.json({ error: "段落不存在" }, { status: 404 });
  }

  // 查词典获取 lemma / phonetic / translation / pos
  const dictResult = lookup(word.trim());

  const lemmaForm = dictResult.lemmaForm || word.trim();
  const displayForm = word.trim();
  const phonetic = dictResult.entry?.phonetic ?? null;
  const translation = dictResult.entry?.translation ?? aiGloss?.slice(0, 500) ?? "(待补充释义)";
  const pos = dictResult.entry?.pos ?? null;

  const now = Date.now();
  const wordId = randomUUID();
  const contextId = randomUUID();
  const isPhrase = /\s/.test(displayForm) ? 1 : 0;

  let finalWordId: string = wordId;
  let finalStatus = "learning";
  let finalStarred = 0;
  // 本次是否为「新建词条」。已存在的词再点一次只是补一条 context，
  // 不该被「取消翻译即删除」误删（老词可能已标记已掌握/星标）。
  let created = true;

  // 同步事务：upsert user_words + insert context
  db.transaction((tx) => {
    // 按 (userId, lemma) 去重：已存在则更新，不存在则插入
    const existing = tx
      .select()
      .from(userWords)
      .where(eq(userWords.lemma, lemmaForm))
      .get() as typeof userWords.$inferSelect | undefined;

    let resolvedWordId: string;

    if (existing) {
      resolvedWordId = existing.id;
      // 更新：如果新词典查到了更好的数据，覆盖。
      // 之前被移出词库（deleted）的词再次被点查 = 重新收下。
      const nextStatus = existing.status === "deleted" ? "learning" : existing.status;
      tx.update(userWords)
        .set({
          displayForm,
          phonetic: phonetic ?? existing.phonetic,
          translation: translation !== "(待补充释义)" ? translation : existing.translation,
          pos: pos ?? existing.pos,
          isPhrase,
          status: nextStatus,
        })
        .where(eq(userWords.id, existing.id))
        .run();
      finalStatus = nextStatus;
      finalStarred = existing.starred;
      created = false;
    } else {
      resolvedWordId = wordId;
      tx.insert(userWords)
        .values({
          id: wordId,
          userId: LOCAL_USER,
          lemma: lemmaForm,
          displayForm,
          pos,
          phonetic,
          translation,
          note: null,
          createdAt: now,
          isPhrase,
        })
        .run();
    }

    finalWordId = resolvedWordId;

    // 插入 context（不去重：同一个词在不同位置/不同文本出现，各记一条）
    tx.insert(contexts)
      .values({
        id: contextId,
        userWordId: resolvedWordId,
        textId,
        paragraphId,
        start,
        end,
        quote,
        prefix,
        suffix,
        aiGloss: aiGloss ?? null,
        createdAt: now,
      })
      .run();
  });

  return NextResponse.json({
    ok: true,
    // 注意：必须返回真正落库的那条记录 id（existing 时 ≠ 新生成的 wordId）
    wordId: finalWordId,
    contextId,
    lemma: lemmaForm,
    displayForm,
    translation,
    phonetic,
    pos,
    status: finalStatus,
    starred: finalStarred,
    isPhrase: isPhrase === 1,
    created,
  });
}

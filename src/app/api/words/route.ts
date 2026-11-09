import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { userWords, contexts } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { InvalidAnchorError, saveWordAndContext, type WordAnchor } from "@/lib/word-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/words
 * 列出当前用户的所有收词，按时间倒序。
 * 可选 ?textId=xxx 只列某篇文章里收的词。
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
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
    .where(eq(userWords.userId, user.id))
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
 *   aiGloss?:   AI 释义全文（如有）。完整存 contexts.ai_gloss 供回看；
 *               词典未收录时才用 cardGloss() 提炼短释义填 translation，
 *               句子地图 / 成分标注不进词库与墨墨卡片背面（P10）。
 */
export async function POST(req: Request) {
  let body: WordAnchor & { aiGloss?: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  if (!body.word?.trim() || !body.textId || !body.paragraphId || !body.quote) {
    return NextResponse.json({ error: "缺少必填字段" }, { status: 400 });
  }

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  // 落库规则统一收口在 lib/word-store.ts（/api/contexts/gloss 也用它补建批注），
  // 避免「收词」和「AI 释义补建」两条路径各写一份 upsert 逻辑后行为漂移。
  try {
    return NextResponse.json(saveWordAndContext(body, user.id));
  } catch (err) {
    if (err instanceof InvalidAnchorError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

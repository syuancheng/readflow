import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contexts, userWords } from "@/db/schema";
import { cardGloss } from "@/lib/gloss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/contexts/[id]
 * 把 AI 释义**全文**回填到某条批注，翻回去看时不用重新请求 AI。
 * 若词条释义还是占位符，顺手用 cardGloss() 提炼的短释义补上（词库页 / 卡片背面）。
 * 句子地图贴死在原句上，只留在 contexts.ai_gloss，不写进 user_words.translation。
 *
 * Body: { aiGloss: string }
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { aiGloss?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (typeof body.aiGloss !== "string") {
    return NextResponse.json({ error: "aiGloss 必须是字符串" }, { status: 400 });
  }

  const row = db.select().from(contexts).where(eq(contexts.id, id)).get();
  if (!row) {
    return NextResponse.json({ error: "批注不存在" }, { status: 404 });
  }

  const gloss = body.aiGloss;
  db.update(contexts).set({ aiGloss: gloss }).where(eq(contexts.id, id)).run();

  // 回填词条释义，让词库页也能看到：
  // - 短语/句子：词典本来就查不到，用 AI 主体段的短释义覆盖
  // - 单词：词典释义更规整，只在还是占位符时补上
  // 降级提示 / 报错文案提炼不出释义，此时什么都不覆盖。
  const short = cardGloss(gloss);
  const word = db.select().from(userWords).where(eq(userWords.id, row.userWordId)).get();
  if (word && short) {
    if (word.isPhrase === 1) {
      db.update(userWords).set({ translation: short }).where(eq(userWords.id, word.id)).run();
    } else if (word.translation === "(待补充释义)" || !word.translation) {
      db.update(userWords).set({ translation: short }).where(eq(userWords.id, word.id)).run();
    }
  }

  return NextResponse.json({ ok: true });
}

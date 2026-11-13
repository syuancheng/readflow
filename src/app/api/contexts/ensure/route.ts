import { NextResponse } from "next/server";
import { InvalidAnchorError, ensureContextByAnchor, type WordAnchor } from "@/lib/word-store";
import { currentUser } from "@/lib/auth";
import { lookup } from "@/lib/dict";
import { logLookup } from "@/lib/learner-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/contexts/ensure —— 确保「本文这一处」有一条批注（按锚点幂等）
 *
 * 收词状态（user_words，全量）和批注（contexts，按文章 + 位置）是两件事：
 * 一个词在别的文章收过，点开时仍应该给当前这一处留一条批注，
 * 否则「已收词 ✓」和「已存批注」列表会对不上。
 *
 * 已有 context → 原样返回，不重复插；没有 → 按 /api/words 的同一套规则
 * upsert 词条 + 插一条 context。重复点同一个位置天然幂等。
 *
 * Body: WordAnchor & { aiGloss?: string }
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  let body: WordAnchor & { aiGloss?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  if (
    !body.word?.trim() ||
    !body.textId ||
    !body.paragraphId ||
    !body.quote ||
    !Number.isFinite(body.start) ||
    !Number.isFinite(body.end) ||
    body.end <= body.start
  ) {
    return NextResponse.json({ error: "缺少必填字段" }, { status: 400 });
  }

  try {
    const saved = ensureContextByAnchor(
      {
          word: body.word,
          textId: body.textId,
          paragraphId: body.paragraphId,
          start: body.start,
          end: body.end,
          quote: body.quote,
          prefix: body.prefix ?? "",
          suffix: body.suffix ?? "",
          ...(typeof body.aiGloss === "string" ? { aiGloss: body.aiGloss } : {}),
        },
        user.id,
      );
    // P32 F2：查词事件只用于行为推断，失败不能影响收词本身
    try {
      let dictHit: boolean | null = null;
      try { dictHit = Boolean(lookup(body.quote).entry); } catch { /* 词典库没导入 */ }
      const rc = (body as { repeatCount?: unknown }).repeatCount;
      logLookup({
        userId: user.id,
        word: body.quote,
        lemma: saved.lemma,
        via: "reader",
        contextId: saved.contextId,
        textId: body.textId,
        repeatCount: typeof rc === "number" ? rc : null,
        dictHit,
      });
    } catch (err) {
      console.error("[learner] 记录查词事件失败:", err);
    }
    return NextResponse.json(saved);
  } catch (err) {
    if (err instanceof InvalidAnchorError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

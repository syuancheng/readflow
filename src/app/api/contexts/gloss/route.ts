import { NextResponse } from "next/server";
import { isNotAGloss } from "@/lib/explain-policy";
import { InvalidAnchorError, persistGlossByAnchor, type WordAnchor } from "@/lib/word-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/contexts/gloss —— AI 释义写回（按锚点幂等）
 *
 * 阅读器生成完 AI 答案后只发「锚点 + 释义全文」，不再自己找 contextId。
 * 服务端按 (textId, paragraphId, start, end) 决定：
 *   已有批注 → 更新 ai_gloss；
 *   没有批注 → 补建词条 + 批注（词在别的文章收过、自动收词关闭、异步竞态都走这里）。
 *
 * 这样「只要点了 AI 释义，结果就应该保存下来」不再依赖前端的闭包时序。
 * 同一个锚点重复写（重试、Ask AI 追问）只覆盖，不会堆出多条重复批注。
 *
 * Body: WordAnchor & { aiGloss: string }
 */
export async function POST(req: Request) {
  let body: WordAnchor & { aiGloss?: unknown };
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
  if (typeof body.aiGloss !== "string" || isNotAGloss(body.aiGloss)) {
    // 「没配模型」的引导文案和报错文案不是释义，写进去会被当成已存答案展示
    return NextResponse.json({ error: "不是有效的释义内容" }, { status: 400 });
  }

  try {
    const result = persistGlossByAnchor({
      word: body.word,
      textId: body.textId,
      paragraphId: body.paragraphId,
      start: body.start,
      end: body.end,
      quote: body.quote,
      prefix: body.prefix ?? "",
      suffix: body.suffix ?? "",
      aiGloss: body.aiGloss,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InvalidAnchorError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

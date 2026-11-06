import { NextResponse } from "next/server";
import { InvalidAnchorError, applyGlossToContext } from "@/lib/word-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/contexts/[id]
 * 把 AI 释义**全文**回填到某条批注，翻回去看时不用重新请求 AI。
 * 若词条释义还是占位符，顺手用 cardGloss() 提炼的短释义补上（词库页 / 卡片背面）。
 * 句子地图贴死在原句上，只留在 contexts.ai_gloss，不写进 user_words.translation。
 *
 * 注意：现在阅读器主链路走 POST /api/contexts/gloss（按锚点写回，
 * 不依赖客户端先拿到 contextId）；这里保留给已知 id 的调用方 / 旧客户端。
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

  try {
    applyGlossToContext(id, body.aiGloss);
  } catch (err) {
    if (err instanceof InvalidAnchorError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}

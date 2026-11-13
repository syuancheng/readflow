import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { sqlite } from "@/db/sqlite";
import { renderPreview } from "@/lib/cards/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cards/sets/:id（P33 spec §7.3）
 * 返回组的状态和卡片预览（renderPreview）。前端每 2 秒轮询，
 * 直到 ready / failed，最长 60 秒。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { id } = await ctx.params;

  const set = sqlite
    .prepare("SELECT * FROM card_sets WHERE id = ? AND user_id = ?")
    .get(id, user.id) as
    | {
        id: string; user_word_id: string; context_id: string; text_id: string;
        status: string; error: string | null; regen_count: number;
        cache_hit_tokens: number | null; prompt_tokens: number | null; completion_tokens: number | null;
      }
    | undefined;
  if (!set) return NextResponse.json({ error: "卡片组不存在" }, { status: 404 });

  const word = sqlite
    .prepare("SELECT display_form FROM user_words WHERE id = ?")
    .get(set.user_word_id) as { display_form: string } | undefined;
  const text = sqlite
    .prepare("SELECT title FROM texts WHERE id = ?")
    .get(set.text_id) as { title: string } | undefined;

  const rows = sqlite
    .prepare("SELECT * FROM cards WHERE set_id = ? ORDER BY seq")
    .all(id) as
    | {
        id: string; seq: number; spec: string; content: string; status: string;
        needs_review: string | null; edited: number; created_at: number; updated_at: number;
      }[]
    | undefined;

  const cards = (rows ?? []).map((c) => {
    const spec = JSON.parse(c.spec);
    return {
      id: c.id,
      seq: c.seq,
      status: c.status,
      needsReview: c.needs_review,
      edited: c.edited === 1,
      spec,
      preview: renderPreview(spec, { sourceTitle: text?.title ?? "" }),
      content: c.content,
    };
  });

  return NextResponse.json({
    set: {
      id: set.id,
      status: set.status,
      error: set.error,
      word: word?.display_form ?? "",
      regenCount: set.regen_count,
      cacheHitTokens: set.cache_hit_tokens,
      promptTokens: set.prompt_tokens,
      completionTokens: set.completion_tokens,
    },
    cards,
  });
}

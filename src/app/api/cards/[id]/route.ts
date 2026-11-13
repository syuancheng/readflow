import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { sqlite } from "@/db/sqlite";
import { parseCardGen } from "@/lib/cards/spec";
import { validateCard } from "@/lib/cards/validate";
import { renderCardChecked } from "@/lib/cards/render";
import { examFamilyOf, examStyleLabel } from "@/lib/cards/style";
import { getLearner, surveyOf } from "@/lib/learner-store";
import { inlineGloss } from "@/lib/gloss";
import { charLimitOfUser, listeningOn } from "@/lib/cards/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/cards/:id（P33 spec §7.4）
 * Body: { spec }。修改后重新校验 + 渲染；原句不能改。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { id } = await ctx.params;

  let body: { spec?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const card = sqlite
    .prepare("SELECT * FROM cards WHERE id = ? AND user_id = ?")
    .get(id, user.id) as
    | {
        id: string; set_id: string; seq: number; spec: string; content: string; status: string;
      }
    | undefined;
  if (!card) return NextResponse.json({ error: "卡片不存在" }, { status: 404 });
  if (card.status !== "draft") {
    return NextResponse.json({ error: "只有草稿卡可以修改" }, { status: 400 });
  }

  const parsed = parseCardGen(JSON.stringify({ cards: [body.spec] }));
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 400 });
  // 考试风格标签由系统按学生档案写，前端传来的不算数
  let family = null;
  try {
    family = examFamilyOf(surveyOf(getLearner(user.id)));
  } catch {
    /* 读不到问卷就不显示风格标签 */
  }
  const next = { ...parsed.cards[0], examStyle: examStyleLabel(family, parsed.cards[0].kind) };

  // 原句一字不改（spec §7.4）：与原 spec 里的 original 句子比对
  const oldSpec = JSON.parse(card.spec) as {
    front: { t: string; source?: string; text?: string; options?: { text: string }[] }[];
  };
  const sentenceTextOf = (b: { t: string; source?: string; text?: string; options?: { text: string }[] }) =>
    b.t === "sentence" || b.t === "instruction" || b.t === "text" ? (b.text ?? "") : "";
  const oldOriginals = oldSpec.front
    .filter((b) => b.t === "sentence" && b.source === "original")
    .map(sentenceTextOf);
  const newOriginals = next.front
    .filter((b): b is Extract<typeof b, { t: "sentence" }> => b.t === "sentence" && b.source === "original")
    .map((b) => b.text);
  if (JSON.stringify(oldOriginals) !== JSON.stringify(newOriginals)) {
    return NextResponse.json({ error: "原句是从文章里引用的，不能修改" }, { status: 400 });
  }

  // 校验（spec §7.4：修改后重新跑 validateCard）
  const context = loadValidateContext(card.set_id, user.id);
  const text = sqlite
    .prepare(
      `SELECT t.title FROM texts t JOIN card_sets s ON s.text_id = t.id WHERE s.id = ?`,
    )
    .get(card.set_id) as { title: string } | undefined;
  const charLimit = charLimitOfUser(user.id);
  const v = validateCard(next, {
    originalSentence: context.originalSentence,
    quote: context.quote,
    glossZh: context.glossZh,
    listeningEnabled: listeningOn(),
    charLimit,
    sourceTitle: text?.title ?? "",
  });
  if (!v.ok) return NextResponse.json({ error: v.reasons.join("；"), reasons: v.reasons }, { status: 400 });

  const rendered = renderCardChecked(next, { sourceTitle: text?.title ?? "" }, { charLimit });
  if (!rendered.ok) {
    return NextResponse.json({ error: rendered.problems.join("；") }, { status: 400 });
  }

  // 用户亲手改过、并且通过了校验 → 「需要检查」标记清掉（改过就是人看过了）
  const now = Date.now();
  sqlite
    .prepare("UPDATE cards SET spec = ?, content = ?, edited = 1, needs_review = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(next), rendered.content, now, id);
  return NextResponse.json({ ok: true, content: rendered.content });
}

/**
 * DELETE /api/cards/:id：status → 'discarded'（软删，方便统计换一道率/推送率）。
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { id } = await ctx.params;
  const card = sqlite
    .prepare("SELECT id, status FROM cards WHERE id = ? AND user_id = ?")
    .get(id, user.id) as { id: string; status: string } | undefined;
  if (!card) return NextResponse.json({ error: "卡片不存在" }, { status: 404 });
  if (card.status !== "draft") {
    return NextResponse.json({ error: "只有草稿卡可以删除" }, { status: 400 });
  }
  sqlite
    .prepare("UPDATE cards SET status = 'discarded', updated_at = ? WHERE id = ?")
    .run(Date.now(), id);
  return NextResponse.json({ ok: true });
}

// ---------- 共用查询 ----------

function loadValidateContext(setId: string, userId: string) {
  const ctx = sqlite
    .prepare(
      `SELECT c.quote, c.prefix, c.suffix, c.ai_gloss, w.translation
         FROM card_sets s
         JOIN contexts c ON c.id = s.context_id
         JOIN user_words w ON w.id = s.user_word_id
        WHERE s.id = ? AND s.user_id = ?`,
    )
    .get(setId, userId) as
    | { quote: string; prefix: string; suffix: string; ai_gloss: string | null; translation: string }
    | undefined;
  const originalSentence = ctx ? `${ctx.prefix}${ctx.quote}${ctx.suffix}`.trim() : "";
  const glossZh = ctx ? inlineGloss(ctx.ai_gloss, ctx.translation, 40) || null : null;
  return { originalSentence, quote: ctx?.quote ?? "", glossZh };
}

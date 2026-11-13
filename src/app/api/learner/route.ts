/** P32：学习档案（问卷 / 反馈行开关 / 水平）。只返回当前登录用户自己的数据。 */
import { currentUser } from "@/lib/auth";
import { allSettings } from "@/lib/settings-store";
import { resolveProvider } from "@/lib/config";
import {
  getLearner,
  getProfileForPrompt,
  lookupCountSince,
  needsSurvey,
  saveSurvey,
  setShowFeedback,
  surveyOf,
  editNote,
} from "@/lib/learner-store";
import { SURVEY_QUESTIONS, EXAM_SCORE_BANDS } from "@/lib/learner/survey";

export const dynamic = "force-dynamic";

const NOTE_MIN_NEW_LOOKUPS = 25;

export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });

  const row = getLearner(user.id);
  const profile = getProfileForPrompt(user.id);
  const lookupCount = lookupCountSince(user.id, row.memory_reset_at);
  const modelReady = resolveProvider(allSettings(), process.env) !== null;

  return Response.json({
    ok: true,
    questions: SURVEY_QUESTIONS,
    scoreBands: EXAM_SCORE_BANDS,
    survey: surveyOf(row),
    showFeedback: row.show_feedback === 1,
    needsSurvey: needsSurvey(row),
    personalized: profile.personalized,
    level: profile.level
      ? {
          cefr: profile.level.cefr,
          vocab: profile.level.vocab,
          basis: profile.level.basis ?? null,
          basisText:
            [
              (profile.stats?.lookups ?? 0) >= 30 ? `最近 ${profile.stats?.lookups} 次查词` : null,
              profile.survey ? "问卷" : null,
            ]
              .filter(Boolean)
              .join(" + ") || "还没有足够的信息",
        }
      : null,
    stats: profile.stats,
    difficulties: profile.stats?.difficulties ?? [],
    note: row.note,
    noteUpdatedAt: row.note_updated_at,
    noteReason: !modelReady
      ? "no_model"
      : row.note
        ? null
        : { need_more_lookups: Math.max(0, NOTE_MIN_NEW_LOOKUPS - lookupCount) },
  });
}

export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  let body: { survey?: unknown; showFeedback?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (body.survey !== undefined) saveSurvey(user.id, body.survey);
  if (typeof body.showFeedback === "boolean") setShowFeedback(user.id, body.showFeedback);
  // F6「这不准确」：用户直接编辑老师笔记，长度 / Markdown 由 editNote 校验
  if (body.note !== undefined) {
    try {
      editNote(user.id, typeof body.note === "string" ? body.note : "");
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "笔记保存失败" },
        { status: 400 },
      );
    }
  }
  return GET();
}

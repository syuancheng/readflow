import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contexts, userWords } from "@/db/schema";
import { extensionError, preflight, requireExtensionUser, withCors } from "@/lib/extension-http";
import { applyGlossToContext } from "@/lib/word-store";
import { serializeThread, type ThreadTurn } from "@/lib/ai-thread";
import { isNotAGloss } from "@/lib/explain-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return preflight();
}

type Body = { contextId?: unknown; turns?: unknown };

/** 校验这条 context 归当前账号：context → user_words.user_id */
function ownsContext(contextId: string, userId: string): boolean {
  const row = db
    .select({ userId: userWords.userId })
    .from(contexts)
    .innerJoin(userWords, eq(userWords.id, contexts.userWordId))
    .where(eq(contexts.id, contextId))
    .get();
  return row?.userId === userId;
}

/**
 * POST /api/extension/gloss
 * 保存 AI 对话串（对应网站的 /api/contexts/gloss）。
 * 过滤掉「没配置模型」「[Error: …]」这类不是释义的段落，空串不写。
 */
export async function POST(req: Request) {
  const auth = requireExtensionUser(req);
  if ("response" in auth) return auth.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return extensionError("请求格式错误", 400);
  }

  const contextId = typeof body.contextId === "string" ? body.contextId.trim() : "";
  if (!contextId) return extensionError("缺少记录 ID", 400);

  const turns: ThreadTurn[] = Array.isArray(body.turns)
    ? body.turns
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
        .map((t) => ({
          ...(typeof t.ask === "string" ? { ask: t.ask.slice(0, 500) } : {}),
          text: typeof t.text === "string" ? t.text.slice(0, 20000) : "",
        }))
        .filter((t) => t.text.trim() && !isNotAGloss(t.text))
    : [];

  const serialized = serializeThread(turns);
  if (!serialized.trim()) return withCors(NextResponse.json({ ok: true }));

  if (!ownsContext(contextId, auth.user.id)) return extensionError("记录不存在", 404);

  applyGlossToContext(contextId, serialized);
  return withCors(NextResponse.json({ ok: true }));
}

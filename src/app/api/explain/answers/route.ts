/** P34 F4：GET /api/explain/answers?contextId= → 这条批注下保存过的回答与反馈（回看时显示反馈行用） */
import { currentUser } from "@/lib/auth";
import { answersForContext } from "@/lib/learner-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  const contextId = new URL(req.url).searchParams.get("contextId")?.trim().slice(0, 120) ?? "";
  if (!contextId) return Response.json({ error: "缺少 contextId" }, { status: 400 });
  // 只查 user_id = 当前用户的行，别人的批注 id 一律返回空列表
  return Response.json({ answers: answersForContext(user.id, contextId) });
}

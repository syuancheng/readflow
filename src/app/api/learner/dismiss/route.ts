/** P32：「以后再说」/ 关掉首页提示卡片，只影响当前登录用户。 */
import { currentUser } from "@/lib/auth";
import { dismissSurvey } from "@/lib/learner-store";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  dismissSurvey(user.id);
  return Response.json({ ok: true });
}

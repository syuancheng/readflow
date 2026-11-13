/**
 * P32 F6：「清空 AI 记忆」。前端先做二次确认再调用。
 * 只清掉老师笔记和行为推断缓存，查词记录（explain_events）本身不删；
 * 之后画像从 memory_reset_at 之后的事件重算，回到问卷起点。
 */
import { currentUser } from "@/lib/auth";
import { resetMemory } from "@/lib/learner-store";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  resetMemory(user.id);
  return Response.json({ ok: true });
}

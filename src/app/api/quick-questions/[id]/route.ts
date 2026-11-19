import { currentUser } from "@/lib/auth";
import { removeQuickQuestion } from "@/lib/quick-question-store";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  const { id } = await ctx.params;
  if (!removeQuickQuestion(user.id, id)) return Response.json({ error: "没有这个常用问题" }, { status: 404 });
  return Response.json({ ok: true });
}

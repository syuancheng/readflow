/** 常用问题（P44）：只读写当前登录用户自己的。 */
import { currentUser } from "@/lib/auth";
import { addQuickQuestion, listQuickQuestions } from "@/lib/quick-question-store";
import { checkAdd } from "@/lib/quick-questions";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  return Response.json({ ok: true, items: listQuickQuestions(user.id) });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const check = checkAdd(listQuickQuestions(user.id).map((q) => q.text), body?.text);
  if (!check.ok) return Response.json({ error: check.reason }, { status: 400 });
  return Response.json({ ok: true, item: addQuickQuestion(user.id, check.text) });
}

/** P32 F5：网站里的「太浅 / 刚好 / 太深」反馈。 */
import { currentUser } from "@/lib/auth";
import { submitFeedback } from "@/lib/feedback-handler";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }
  const result = submitFeedback(user.id, body);
  return Response.json(result.ok ? { ok: true } : { error: result.error }, { status: result.ok ? 200 : result.status });
}

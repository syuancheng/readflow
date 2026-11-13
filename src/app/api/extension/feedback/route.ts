/** P32 F5：插件侧栏里的反馈，凭插件 Token 认人。 */
import { extensionError, preflight, requireExtensionUser, withCors } from "@/lib/extension-http";
import { submitFeedback } from "@/lib/feedback-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return preflight();
}

export async function POST(req: Request) {
  const auth = requireExtensionUser(req);
  if ("response" in auth) return auth.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return extensionError("请求格式错误", 400);
  }
  const result = submitFeedback(auth.user.id, body);
  if (!result.ok) return extensionError(result.error, result.status);
  return withCors(new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

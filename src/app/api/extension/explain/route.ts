import type { ExplainParams } from "@/lib/ai";
import { explainParamsFromBody, handleExplain } from "@/lib/explain-handler";
import { extensionError, preflight, requireExtensionUser, withCors } from "@/lib/extension-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return preflight();
}

/**
 * POST /api/extension/explain
 * 插件里的「AI 释义」。和主站 /api/explain 走同一个处理：按这个人的模型配置，
 * 用站点模型时同样扣每日免费次数。
 */
export async function POST(req: Request) {
  const auth = requireExtensionUser(req);
  if ("response" in auth) return auth.response;
  let body: Partial<ExplainParams> = {};
  try {
    body = await req.json();
  } catch {
    return extensionError("请求格式错误", 400);
  }
  const params = explainParamsFromBody(body);
  if (!params) return extensionError("缺少要解释的词", 400);
  return withCors(await handleExplain(params, auth.user, { via: "extension" }));
}

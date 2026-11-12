/**
 * 插件接口（/api/extension/*）的公共部分：跨域头 + 按 Token 认人。
 *
 * 插件从 chrome-extension:// 发请求、不带 ReadFlow 的登录 cookie，
 * 所以这些接口在 proxy.ts 里放行，身份完全由 x-readflow-token（或 Bearer）决定。
 */
import { NextResponse } from "next/server";
import type { AuthUser } from "@/lib/auth";
import { userFromExtensionToken } from "@/lib/extension-tokens";

export const EXTENSION_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-readflow-token, Authorization",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "86400",
};

export function withCors<T extends Response>(res: T): T {
  for (const [k, v] of Object.entries(EXTENSION_CORS)) res.headers.set(k, v);
  return res;
}

export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: EXTENSION_CORS });
}

export function extensionError(error: string, status: number): NextResponse {
  return withCors(NextResponse.json({ ok: false, error }, { status }));
}

/** 解析请求里的插件 Token；返回账号，或一个已带跨域头的 401 响应 */
export function requireExtensionUser(req: Request): { user: AuthUser } | { response: NextResponse } {
  const header = req.headers.get("x-readflow-token") ?? "";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const user = userFromExtensionToken((header || bearer).trim());
  if (!user) {
    return {
      response: extensionError(
        "插件 Token 无效或已重新生成：请在 ReadFlow → 设置 → 浏览器插件 里生成，并填进插件",
        401,
      ),
    };
  }
  return { user };
}

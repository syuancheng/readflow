import { NextResponse } from "next/server";
import { extensionError, preflight, requireExtensionUser, withCors } from "@/lib/extension-http";
import { recallWord } from "@/lib/extension-record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return preflight();
}

/**
 * GET /api/extension/word/:id
 * 点网页上已存词的高亮时回看：返回这个词最新一条 context 的数据。
 * 不查词典、不调 AI、不自动讲解（与阅读页点回绿色划线一致）。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireExtensionUser(_req);
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const result = recallWord(auth.user.id, id);
  if (!result.ok) return extensionError("词条不存在", 404);

  return withCors(NextResponse.json(result.payload));
}

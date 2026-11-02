import { NextRequest } from "next/server";
import { lookup } from "@/lib/dict";

export const dynamic = "force-dynamic";

/**
 * 词典查询接口
 * GET /api/dict?word=rained
 *
 * 对齐 Readlang 的设计：词典是第一层，快速返回（<5ms）。
 * 返回词形还原后的完整释义。
 */
export async function GET(req: NextRequest) {
  const word = req.nextUrl.searchParams.get("word")?.trim();

  if (!word) {
    return Response.json({ error: "word is required" }, { status: 400 });
  }

  try {
    const result = lookup(word);
    return Response.json(result);
  } catch (err) {
    // ECDICT 未导入等情况
    const msg = err instanceof Error ? err.message : "lookup failed";
    return Response.json({ error: msg, entry: null }, { status: 500 });
  }
}

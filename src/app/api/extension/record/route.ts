import { NextResponse } from "next/server";
import { preflight, requireExtensionUser, withCors, extensionError } from "@/lib/extension-http";
import { recordFromWeb, type RecordInput } from "@/lib/extension-record";
import { deleteWordContexts } from "@/lib/word-store";
import { stripHash } from "@/lib/web-anchor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BLOCK = 4000;

export async function OPTIONS() {
  return preflight();
}

type Body = {
  word?: unknown;
  block?: unknown;
  start?: unknown;
  end?: unknown;
  url?: unknown;
  title?: unknown;
  source?: unknown;
  repeatCount?: unknown;
};

/**
 * POST /api/extension/record
 * 插件点词自动记录（对应网站的 /api/contexts/ensure）。
 *
 * 插件先把块文本归一化、算好选区坐标再发上来；这里再校验一遍
 * `block.slice(start, end) === word`，不相等就拒绝——宁可少记一条，
 * 也不能让阅读页的绿色划线画到错误的位置。
 */
export async function POST(req: Request) {
  const auth = requireExtensionUser(req);
  if ("response" in auth) return auth.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return extensionError("请求格式错误", 400);
  }

  const word = typeof body.word === "string" ? body.word.trim() : "";
  if (!word || word.length > 120) return extensionError("缺少要查的词", 400);

  const block = typeof body.block === "string" ? body.block : "";
  if (!block.trim()) return extensionError("缺少选区所在的段落", 400);
  if (block.length > MAX_BLOCK) return extensionError("段落太长了，换一段再查", 413);

  const start = typeof body.start === "number" ? Math.trunc(body.start) : NaN;
  const end = typeof body.end === "number" ? Math.trunc(body.end) : NaN;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > block.length
  ) {
    return extensionError("选区坐标无效", 400);
  }
  if (block.slice(start, end) !== word) {
    return extensionError("选区坐标与原文不一致", 400);
  }

  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return extensionError("缺少网页地址", 400);
  }
  if (!/^https?:$/.test(parsed.protocol) || rawUrl.length > 2000) {
    return extensionError("只支持 http / https 网页", 400);
  }
  const url = stripHash(rawUrl);

  const title =
    (typeof body.title === "string" ? body.title.trim().slice(0, 200) : "") || url || "网页摘录";
  const source: RecordInput["source"] = body.source === "select" ? "select" : "word";
  const repeatCount =
    typeof body.repeatCount === "number" && Number.isFinite(body.repeatCount)
      ? Math.max(1, Math.min(99, Math.trunc(body.repeatCount)))
      : 1;

  try {
    const payload = recordFromWeb(auth.user.id, {
      word,
      block,
      start,
      end,
      url,
      title,
      source,
      repeatCount,
    });
    return withCors(NextResponse.json(payload));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "记录失败";
    return extensionError(msg, 422);
  }
}

/**
 * DELETE /api/extension/record?wordId=…&contextId=…
 * 取消记录：删掉这一条 context；这个词再没有其它记录时连词条一起删。
 */
export async function DELETE(req: Request) {
  const auth = requireExtensionUser(req);
  if ("response" in auth) return auth.response;

  const q = new URL(req.url).searchParams;
  const wordId = q.get("wordId")?.trim() ?? "";
  const contextId = q.get("contextId")?.trim() ?? "";
  if (!wordId || !contextId) return extensionError("缺少要删除的记录", 400);

  // 别人的词条一律按「不存在」处理，不暴露数据是否存在
  const result = deleteWordContexts(wordId, auth.user.id, { contextId });
  if (!result.ok) return extensionError("记录不存在", 404);

  return withCors(NextResponse.json({ ok: true, prunedWord: result.prunedWord }));
}

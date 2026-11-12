import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { texts } from "@/db/schema";
import { extractFromHtml } from "@/lib/readability";
import { blocksFromExtracted, createText, EmptyTextError } from "@/lib/create-text";
import { extensionError, preflight, requireExtensionUser, withCors } from "@/lib/extension-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 整个请求体上限：页面 HTML（插件已去掉脚本 / 样式）+ 可能的官方 Markdown */
const MAX_BODY = 6 * 1024 * 1024;
const MAX_HTML = 5 * 1024 * 1024;
const MAX_MARKDOWN = 2 * 1024 * 1024;

export async function OPTIONS() {
  return preflight();
}

type ImportBody = {
  url?: unknown;
  title?: unknown;
  html?: unknown;
  markdown?: unknown;
  /** 同一网址已导入过时，true = 仍然再导入一篇 */
  force?: unknown;
};

/**
 * POST /api/extension/import
 * 插件「导入当前网页」（P30）。
 *
 * 服务器在国内、很多国外网站抓不到；但用户自己的浏览器打得开。所以由插件把
 * 已渲染好的页面 HTML（和站点声明的官方 Markdown，若有）交上来，服务器不联网，
 * 走和 URL 导入完全相同的解析与落库：extractFromHtml → blocksFromExtracted → createText。
 */
export async function POST(req: Request) {
  const auth = requireExtensionUser(req);
  if ("response" in auth) return auth.response;
  const user = auth.user;

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return extensionError("页面太大了（超过 5MB），换一篇或用粘贴导入", 413);

  let body: ImportBody;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return extensionError("页面太大了（超过 5MB），换一篇或用粘贴导入", 413);
    body = JSON.parse(raw) as ImportBody;
  } catch {
    return extensionError("请求格式错误", 400);
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return extensionError("缺少网页地址", 400);
  }
  if (!/^https?:$/.test(parsedUrl.protocol) || url.length > 2000) {
    return extensionError("只能导入 http / https 网页", 400);
  }
  const html = typeof body.html === "string" ? body.html : "";
  if (!html.trim()) return extensionError("没有拿到页面内容", 400);
  if (html.length > MAX_HTML) return extensionError("页面太大了（超过 5MB），换一篇或用粘贴导入", 413);
  const markdown =
    typeof body.markdown === "string" && body.markdown.length <= MAX_MARKDOWN ? body.markdown : null;
  const pageTitle = typeof body.title === "string" ? body.title.trim().slice(0, 300) : "";

  // 同一个人同一网址只保留一篇整篇导入（网页摘录 source_type='web' 不算）。
  // 从这里的查询到 createText 落库之间没有 await，单进程里两个请求不会交错，
  // 所以插件超时重试 / 连点只会得到 duplicate，不会建出两篇（P30 实测复现过）。
  if (body.force !== true) {
    const existing = db
      .select({ id: texts.id, title: texts.title })
      .from(texts)
      .where(and(eq(texts.userId, user.id), eq(texts.sourceUrl, url), eq(texts.sourceType, "url")))
      .orderBy(desc(texts.createdAt))
      .get();
    if (existing) {
      return withCors(
        NextResponse.json({ ok: true, duplicate: true, id: existing.id, title: existing.title, readPath: `/texts/${existing.id}` }),
      );
    }
  }

  return importPage(user.id, url, html, markdown, pageTitle);
}

function importPage(userId: string, url: string, html: string, markdown: string | null, pageTitle: string) {
  let extracted;
  try {
    extracted = extractFromHtml(html, url, markdown);
  } catch (e) {
    return extensionError((e as Error).message, 422);
  }
  const { blocks, sourceFormat, sourceRaw } = blocksFromExtracted(extracted, url);

  try {
    const created = createText({
      userId,
      // 和 URL 导入一样用 Readability 提取的标题；插件传来的标签页标题只在提取不到时兜底
      title: extracted.title || pageTitle,
      sourceType: "url",
      sourceUrl: url,
      blocks,
      sourceFormat,
      sourceRaw,
    });
    return withCors(NextResponse.json({ ok: true, duplicate: false, ...created, readPath: `/texts/${created.id}` }));
  } catch (e) {
    if (e instanceof EmptyTextError) return extensionError(e.message, 422);
    throw e;
  }
}

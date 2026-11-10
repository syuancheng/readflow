import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { paragraphs, texts } from "@/db/schema";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const [text] = await db.select().from(texts).where(eq(texts.id, id)).limit(1);
  // 用 404 而非 403：不向别的账号暴露「这篇文章存在」
  if (!text || text.userId !== user.id) {
    return NextResponse.json({ error: "文本不存在" }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.textId, id))
    .orderBy(asc(paragraphs.idx));

  return NextResponse.json({ text, paragraphs: rows });
}

/**
 * PATCH /api/texts/{id}
 *
 * 编辑文本元数据（P16 / P18）。四类字段一套入口，各字段独立判断：
 *   { title }    重命名：trim、非空、≤200 字符
 *   { category } 分类：空串/undefined 清空，≤30 字符；预设值由前端约束
 *   { readIdx, readRatio } 阅读进度上报：**覆盖写**（P18 起不再单调合并）。
 *     进度是「当前滚动位置」的估算，往回翻就该下降；单调 max 会让误写的
 *     1.0 永远降不回来，也无法靠重新阅读自愈。单用户场景接受后写胜出。
 *   { completedAt } 「已读完」标记：时间戳＝标记，null＝取消。
 *     这是用户显式断言，与百分比完全解耦，滚到 100% 不会自动写它。
 *
 * 混在同一次请求也没问题；四类字段互不干扰。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body: {
    title?: unknown;
    category?: unknown;
    readIdx?: unknown;
    readRatio?: unknown;
    completedAt?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  // JSON "null" / 数组会让下面的 `in` 判断和属性访问抛异常，先挡掉
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const [row] = await db.select().from(texts).where(eq(texts.id, id)).limit(1);
  if (!row || row.userId !== user.id) {
    return NextResponse.json({ error: "文本不存在" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};

  if (typeof body.title === "string") {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
    if (title.length > 200) return NextResponse.json({ error: "标题太长（上限 200 字符）" }, { status: 400 });
    updates.title = title;
  }

  if (typeof body.category === "string") {
    const category = body.category.trim();
    if (category.length > 30) return NextResponse.json({ error: "分类名太长（上限 30 字符）" }, { status: 400 });
    updates.category = category || null; // 空串 = 恢复未分类
  }

  const hasReadIdx = typeof body.readIdx === "number" && Number.isInteger(body.readIdx) && body.readIdx >= 0;
  const hasReadRatio =
    typeof body.readRatio === "number" &&
    Number.isFinite(body.readRatio) &&
    body.readRatio >= 0 &&
    body.readRatio <= 1;
  // P18：进度是位置估算，允许下降（往回翻 / 从头重读），直接覆盖，不做 max 合并。
  // 这样被旧版误写成 1.0 的文章，打开后读一下就会被真实值改写，无需数据迁移。
  if (hasReadIdx) updates.readIdx = body.readIdx as number;
  if (hasReadRatio) updates.readRatio = body.readRatio as number;

  // 「已读完」是用户显式断言。用 in 判断而不是真值判断：null 表示取消标记，
  // 若写成 `if (body.completedAt)` 会把取消操作整个吞掉。
  if ("completedAt" in body) {
    const v = body.completedAt;
    if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) {
      return NextResponse.json({ error: "completedAt 必须是时间戳或 null" }, { status: 400 });
    }
    updates.completedAt = v as number | null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
  }

  db.update(texts).set(updates).where(eq(texts.id, id)).run();
  const [next] = await db.select().from(texts).where(eq(texts.id, id)).limit(1);
  return NextResponse.json({ text: next });
}

/**
 * DELETE /api/texts/{id}
 *
 * 删除语义（必须保持，前端确认弹窗与词库页都依赖它）：
 *   - 删：texts + paragraphs（外键级联）+ section_summaries（外键级联）
 *   - 留：user_words / contexts / exports —— 阅读时收的词、原句、AI 释义
 *     是用户资产，不随文章消失；contexts 对 texts 没有外键，天然保留。
 *     词库页用 leftJoin 展示，文章删了显示「来自已删除的文章」。
 *     分类与阅读进度列随 texts 一起删除，不构成用户资产。
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const [row] = await db
    .select({ userId: texts.userId })
    .from(texts)
    .where(eq(texts.id, id))
    .limit(1);
  if (!row || row.userId !== user.id) {
    return NextResponse.json({ error: "文本不存在" }, { status: 404 });
  }
  // delete 的 where 也带上 userId，避免校验与写入之间任何竞态
  db.delete(texts).where(and(eq(texts.id, id), eq(texts.userId, user.id))).run();
  return NextResponse.json({ ok: true });
}

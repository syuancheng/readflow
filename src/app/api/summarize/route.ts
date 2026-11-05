import { NextRequest } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { paragraphs, sectionSummaries } from "@/db/schema";
import { hasModelConfigured, NO_MODEL_NOTICE, streamSectionSummary } from "@/lib/ai";
import { STREAM_RESET } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * 分段小结接口。
 *
 * GET  /api/summarize?textId=...        → 本文已生成过的全部小结（用于标记上的圆点提示）
 * POST /api/summarize                   body: { textId, startIdx, endIdx, regenerate? }
 *   → 流式返回该区间的小结；命中缓存时直接回放缓存内容（响应头 x-summary-cached: 1）
 *
 * 安全与一致性：
 * - 正文只从 paragraphs 表按 textId 读，不接受客户端传来的文章内容；
 * - 区间必须对应真实存在的段落，且区间边界就是段落边界（小结标记绝不落在段中间）；
 * - 生成成功才落库；模型未配置 / 出错时不写缓存，避免把提示语当成小结存下来。
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function streamText(
  producer: () => AsyncIterable<string>,
  extra: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of producer()) controller.enqueue(encoder.encode(chunk));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "summary failed";
        controller.enqueue(encoder.encode(`\n\n[Error: ${msg}]`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS, ...extra } });
}

export async function GET(req: NextRequest) {
  const textId = req.nextUrl.searchParams.get("textId")?.trim();
  if (!textId) return Response.json({ error: "textId is required" }, { status: 400 });

  const rows = db
    .select()
    .from(sectionSummaries)
    .where(eq(sectionSummaries.textId, textId))
    .all();

  return Response.json({
    summaries: rows.map((r) => ({
      startIdx: r.startIdx,
      endIdx: r.endIdx,
      content: r.content,
      createdAt: r.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  let body: { textId?: unknown; startIdx?: unknown; endIdx?: unknown; regenerate?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const textId = typeof body.textId === "string" ? body.textId.trim() : "";
  const startIdx = Number(body.startIdx);
  const endIdx = Number(body.endIdx);
  const regenerate = body.regenerate === true;

  if (!textId) return Response.json({ error: "textId is required" }, { status: 400 });
  if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx)) {
    return Response.json({ error: "startIdx/endIdx must be integers" }, { status: 400 });
  }

  const rows = db
    .select({ idx: paragraphs.idx, content: paragraphs.content })
    .from(paragraphs)
    .where(eq(paragraphs.textId, textId))
    .orderBy(asc(paragraphs.idx))
    .all();

  if (rows.length === 0) {
    return Response.json({ error: "text not found or empty" }, { status: 404 });
  }

  const startPos = rows.findIndex((r) => r.idx === startIdx);
  const endPos = rows.findIndex((r) => r.idx === endIdx);
  if (startPos < 0 || endPos < 0 || endPos < startPos) {
    return Response.json({ error: "invalid section range" }, { status: 400 });
  }

  const span = rows.slice(startPos, endPos + 1);

  const cached = db
    .select()
    .from(sectionSummaries)
    .where(and(eq(sectionSummaries.textId, textId), eq(sectionSummaries.endIdx, endIdx)))
    .limit(1)
    .all()[0];

  // 缓存命中：区间起点也必须一致（分段规则变过就作废重生成）
  if (cached && !regenerate && cached.startIdx === startIdx) {
    return streamText(
      async function* () {
        yield cached.content;
      },
      { "x-summary-cached": "1" },
    );
  }

  // 没配模型：如实提示去配置，不落库
  if (!hasModelConfigured()) {
    return streamText(
      async function* () {
        yield NO_MODEL_NOTICE;
      },
      { "x-summary-cached": "0" },
    );
  }

  const encoder = new TextEncoder();
  let acc = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamSectionSummary({
          body: span.map((r) => r.content).join("\n\n"),
          paragraphCount: span.length,
        })) {
          acc += chunk;
          controller.enqueue(encoder.encode(chunk));
        }

        // 重试时上一段半成品会带上重置标记，只保留最后一次的完整输出
        const text = (acc.split(STREAM_RESET).pop() ?? "").trim();
        if (text && !text.startsWith("⚠️")) {
          db.insert(sectionSummaries)
            .values({
              id: randomUUID(),
              textId,
              startIdx,
              endIdx,
              content: text,
              createdAt: Date.now(),
            })
            .onConflictDoUpdate({
              target: [sectionSummaries.textId, sectionSummaries.endIdx],
              set: { startIdx, content: text, createdAt: Date.now() },
            })
            .run();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "summary failed";
        controller.enqueue(encoder.encode(`\n\n[Error: ${msg}]`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS, "x-summary-cached": "0" } });
}

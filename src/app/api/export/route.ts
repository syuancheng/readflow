import { NextResponse } from "next/server";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { contexts, exports, paragraphs, settings, texts, userWords, LOCAL_USER } from "@/db/schema";
import { resolveAnchor } from "@/lib/tokenize";
import { sentenceAround } from "@/lib/split";
import { buildCard, lintCard, CARD_TYPES, type CardType } from "@/lib/cardgen";
import { createCard, hasMarkjiToken, MarkjiError } from "@/lib/markji";
import { distractors } from "@/lib/dict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 墨墨对「每天新建内容」有上限，按 600 条兜住（宁少不多） */
const DAILY_CAP = 600;
/** 单次请求最多处理多少个词，避免一个请求跑十几分钟 */
const MAX_WORDS_PER_RUN = 200;

const TYPE_KEYS = new Set<string>(CARD_TYPES.map((t) => t.key));

function isCardType(v: string): v is CardType {
  return TYPE_KEYS.has(v);
}

function getSetting(key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

function setSetting(key: string, value: string) {
  db.insert(settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
    .run();
}

type ExportItem = {
  wordId: string;
  word: string;
  cardType: CardType;
  content: string;
  status: "pending" | "done" | "skipped" | "failed";
  cardId?: string;
  error?: string;
};

/**
 * GET /api/export
 * 给 UI 用的状态：令牌是否可用、目标牌组/章节、各类卡片的已推送数量、今日已推送量。
 */
export async function GET() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // 词库词数只算还在词库里的（已移出的不导出）
  const wordCount = db
    .select({ c: sql<number>`count(*)` })
    .from(userWords)
    .where(and(eq(userWords.userId, LOCAL_USER), ne(userWords.status, "deleted")))
    .get();

  const byType = db
    .select({ t: exports.cardType, c: sql<number>`count(*)` })
    .from(exports)
    .where(eq(exports.status, "done"))
    .groupBy(exports.cardType)
    .all();

  const todayPushed = db
    .select({ c: sql<number>`count(*)` })
    .from(exports)
    .where(and(eq(exports.status, "done"), gte(exports.pushedAt, todayStart.getTime())))
    .get();

  return NextResponse.json({
    tokenReady: hasMarkjiToken(),
    deckId: getSetting("markji.deck") ?? "",
    chapterId: getSetting("markji.chapter") ?? "",
    deckName: getSetting("markji.deckName") ?? "",
    chapterName: getSetting("markji.chapterName") ?? "",
    wordCount: Number(wordCount?.c ?? 0),
    exportedByType: Object.fromEntries(byType.map((r) => [r.t, Number(r.c)])),
    todayPushed: Number(todayPushed?.c ?? 0),
    dailyCap: DAILY_CAP,
  });
}

/**
 * POST /api/export
 *
 * body: { deckId, chapterId, types: CardType[], wordIds?: string[], dryRun?: boolean, limit?: number }
 *
 * 幂等：exports 表上 (user_word_id, deck_id, card_type) 唯一。已在目标牌组推过的
 * 卡片直接跳过 —— 墨墨不提供删除端点，重复推送的垃圾卡只能在 App 里手删，
 * 所以「不重复写」这件事必须是硬约束，不能靠调用方自觉。
 *
 * dryRun 返回将要发送的卡片全文，不写任何东西。真正写卡前必须先看这个。
 */
export async function POST(req: Request) {
  let body: {
    deckId?: string;
    chapterId?: string;
    types?: string[];
    wordIds?: string[];
    dryRun?: boolean;
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const dryRun = body.dryRun === true;
  const deckId = body.deckId?.trim() ?? "";
  const chapterId = body.chapterId?.trim() ?? "";
  const types = (body.types ?? ["qa"]).filter(isCardType);
  const limit = Math.min(body.limit ?? MAX_WORDS_PER_RUN, MAX_WORDS_PER_RUN);

  if (!dryRun && (!deckId || !chapterId)) {
    return NextResponse.json({ error: "请先选择牌组和章节" }, { status: 400 });
  }
  if (types.length === 0) {
    return NextResponse.json({ error: "至少选择一种卡片类型" }, { status: 400 });
  }
  if (!dryRun && !hasMarkjiToken()) {
    return NextResponse.json(
      { error: "未配置 MARKJI_TOKEN 环境变量，无法写入墨墨" },
      { status: 400 },
    );
  }

  // 1. 选出要导的词（已移出词库的不导——避免把删掉的词再推进墨墨）
  let wordRows = db
    .select()
    .from(userWords)
    .where(and(eq(userWords.userId, LOCAL_USER), ne(userWords.status, "deleted")))
    .orderBy(desc(userWords.createdAt))
    .all();

  if (body.wordIds?.length) {
    const wanted = new Set(body.wordIds);
    wordRows = wordRows.filter((w) => wanted.has(w.id));
  }
  wordRows = wordRows.slice(0, limit);

  // 2. 已推送过的（同一个牌组内的幂等键）
  const doneKeys = new Set<string>();
  if (deckId) {
    for (const row of db.select().from(exports).where(eq(exports.deckId, deckId)).all()) {
      if (row.status === "done") doneKeys.add(`${row.userWordId}:${row.cardType}`);
    }
  }

  // 3. 今日配额
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayRow = db
    .select({ c: sql<number>`count(*)` })
    .from(exports)
    .where(and(eq(exports.status, "done"), gte(exports.pushedAt, todayStart.getTime())))
    .get();
  let remainingToday = DAILY_CAP - Number(todayRow?.c ?? 0);

  const items: ExportItem[] = [];
  const summary = { pushed: 0, skipped: 0, failed: 0, invalid: 0 };
  let previewShown = 0;

  for (const w of wordRows) {
    // 取最近一条上下文，回段落原文里截整句
    const ctx = db
      .select({
        paragraphId: contexts.paragraphId,
        start: contexts.start,
        end: contexts.end,
        quote: contexts.quote,
        prefix: contexts.prefix,
        suffix: contexts.suffix,
        paraContent: paragraphs.content,
        sourceTitle: texts.title,
      })
      .from(contexts)
      .innerJoin(paragraphs, eq(paragraphs.id, contexts.paragraphId))
      .innerJoin(texts, eq(texts.id, contexts.textId))
      .where(eq(contexts.userWordId, w.id))
      .orderBy(desc(contexts.createdAt))
      .limit(1)
      .get();

    if (!ctx) {
      for (const t of types) {
        items.push({
          wordId: w.id,
          word: w.displayForm,
          cardType: t,
          content: "",
          status: "failed",
          error: "这个词没有上下文，无法生成卡片",
        });
        summary.failed++;
      }
      continue;
    }

    // 用锚点回原文定位；定位不到就不要猜，直接报错（猜错会做出错误的卡）
    const hit = resolveAnchor(ctx.paraContent, {
      start: ctx.start,
      end: ctx.end,
      quote: ctx.quote,
      prefix: ctx.prefix,
      suffix: ctx.suffix,
    });

    if (!hit) {
      for (const t of types) {
        items.push({
          wordId: w.id,
          word: w.displayForm,
          cardType: t,
          content: "",
          status: "failed",
          error: "原文里已经找不到这个词（文本可能被重新导入过）",
        });
        summary.failed++;
      }
      continue;
    }

    const { sentence, offset } = sentenceAround(ctx.paraContent, hit.start, hit.end);
    const displayWord = ctx.paraContent.slice(hit.start, hit.end);

    for (const type of types) {
      const key = `${w.id}:${type}`;
      if (doneKeys.has(key)) {
        items.push({
          wordId: w.id,
          word: w.displayForm,
          cardType: type,
          content: "",
          status: "skipped",
        });
        summary.skipped++;
        continue;
      }

      const content = buildCard(type, {
        word: displayWord || w.displayForm,
        lemma: w.lemma,
        phonetic: w.phonetic,
        translation: w.translation,
        sentence,
        offset,
        sourceTitle: ctx.sourceTitle,
        distractors:
          type === "choice"
            ? distractors({ translation: w.translation, word: w.displayForm, lemma: w.lemma })
            : undefined,
      });

      const lint = lintCard(content);
      if (!lint.ok) {
        items.push({
          wordId: w.id,
          word: w.displayForm,
          cardType: type,
          content,
          status: "failed",
          error: `语法自检未通过：${lint.problems.join("；")}`,
        });
        summary.failed++;
        summary.invalid++;
        continue;
      }

      if (dryRun) {
        // 预览只带前几张，避免一个响应几 MB
        items.push({
          wordId: w.id,
          word: w.displayForm,
          cardType: type,
          content: previewShown < 6 ? content : "",
          status: "pending",
        });
        previewShown++;
        continue;
      }

      if (remainingToday <= 0) {
        items.push({
          wordId: w.id,
          word: w.displayForm,
          cardType: type,
          content: "",
          status: "failed",
          error: "已达今日 600 条上限，明天继续",
        });
        summary.failed++;
        continue;
      }

      try {
        const card = await createCard(deckId, chapterId, content);
        remainingToday--;

        db.insert(exports)
          .values({
            id: randomUUID(),
            userWordId: w.id,
            deckId,
            chapterId,
            cardId: card.id,
            cardType: type,
            status: "done",
            error: null,
            pushedAt: Date.now(),
          })
          .onConflictDoUpdate({
            target: [exports.userWordId, exports.deckId, exports.cardType],
            set: {
              chapterId,
              cardId: card.id,
              status: "done",
              error: null,
              pushedAt: Date.now(),
            },
          })
          .run();

        doneKeys.add(key);
        summary.pushed++;
        items.push({
          wordId: w.id,
          word: w.displayForm,
          cardType: type,
          content,
          status: "done",
          cardId: card.id,
        });
      } catch (err) {
        const msg =
          err instanceof MarkjiError ? `${err.code ?? ""} ${err.message}`.trim() : String(err);
        db.insert(exports)
          .values({
            id: randomUUID(),
            userWordId: w.id,
            deckId,
            chapterId,
            cardId: null,
            cardType: type,
            status: "failed",
            error: msg.slice(0, 300),
            pushedAt: null,
          })
          .onConflictDoUpdate({
            target: [exports.userWordId, exports.deckId, exports.cardType],
            set: { status: "failed", error: msg.slice(0, 300) },
          })
          .run();
        summary.failed++;
        items.push({
          wordId: w.id,
          word: w.displayForm,
          cardType: type,
          content,
          status: "failed",
          error: msg,
        });

        // 认证/参数这类错误，后面每一张都会同样失败，立刻停手
        if (err instanceof MarkjiError && err.status >= 400 && err.status < 500) {
          return NextResponse.json(
            {
              ok: false,
              dryRun,
              summary,
              items,
              error: `墨墨拒绝了请求：${msg}（已停止，避免刷出一堆失败记录）`,
              remainingToday,
            },
            { status: 400 },
          );
        }
      }
    }
  }

  if (!dryRun && deckId && chapterId) {
    setSetting("markji.deck", deckId);
    setSetting("markji.chapter", chapterId);
  }

  return NextResponse.json({
    ok: summary.failed === 0,
    dryRun,
    summary,
    items,
    remainingToday,
    wordCount: wordRows.length,
  });
}

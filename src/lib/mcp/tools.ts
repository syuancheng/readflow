/**
 * ReadFlow MCP 工具实现（服务端，按已鉴权的 userId 严格隔离数据）。
 */
import crypto from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { listeningLogs, texts, userWords } from "@/db/schema";
import { blocksFromExtracted, createText, EmptyTextError } from "@/lib/create-text";
import { parsePasted } from "@/lib/import";
import { getProfileForPrompt } from "@/lib/learner-store";
import { validateListeningInput } from "@/lib/listening";
import { extractFromUrl } from "@/lib/readability";
import { getListeningStats, getReadingStats } from "@/lib/stats";
import { dayKey } from "@/lib/streak";
import type { ToolExecResult } from "./protocol";

const MAX_CONTENT_CHARS = 500_000;

export async function executeMcpTool(
  userId: string,
  origin: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecResult> {
  switch (name) {
    case "get_learner_profile":
      return handleGetLearnerProfile(userId);
    case "get_learning_stats":
      return handleGetLearningStats(userId, args);
    case "list_learning_words":
      return handleListLearningWords(userId, args);
    case "log_listening":
      return handleLogListening(userId, args);
    case "import_article":
      return handleImportArticle(userId, origin, args);
    default:
      return { ok: false, error: `未知工具：${name}` };
  }
}

async function handleGetLearnerProfile(userId: string): Promise<ToolExecResult> {
  const profile = getProfileForPrompt(userId);
  const recentTexts = await db
    .select({
      category: texts.category,
      cefrLevel: texts.cefrLevel,
      completedAt: texts.completedAt,
    })
    .from(texts)
    .where(and(eq(texts.userId, userId), ne(texts.sourceType, "web")))
    .orderBy(desc(texts.createdAt))
    .limit(20);

  const categoryCounts: Record<string, number> = {};
  const cefrCounts: Record<string, number> = {};
  for (const t of recentTexts) {
    if (t.category) categoryCounts[t.category] = (categoryCounts[t.category] ?? 0) + 1;
    if (t.cefrLevel) cefrCounts[t.cefrLevel] = (cefrCounts[t.cefrLevel] ?? 0) + 1;
  }

  return {
    ok: true,
    data: {
      level: profile.level,
      levelOverride: profile.levelOverride,
      survey: profile.survey,
      teacherNote: profile.note,
      teachingRules: profile.rules,
      recentReadingSummary: {
        sampledTextCount: recentTexts.length,
        completedInSample: recentTexts.filter((t) => t.completedAt !== null).length,
        categories: categoryCounts,
        cefrDistribution: cefrCounts,
      },
    },
  };
}

async function handleGetLearningStats(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecResult> {
  const dimension =
    args.dimension === "reading" || args.dimension === "listening"
      ? args.dimension
      : "all";

  const data: Record<string, unknown> = {};

  if (dimension === "all" || dimension === "reading") {
    const r = await getReadingStats(userId, 14, 18);
    data.reading = {
      todayWords: r.todayWords,
      weekWords: r.weekWords,
      monthWords: r.monthWords,
      totalWords: r.totalWords,
      completedCount: r.completedCount,
      streakDays: r.streakDays,
      bestStreak: r.bestStreak,
      activeDays: r.activeDays,
      recentCompleted: r.recentCompleted.slice(0, 5).map((t) => ({
        id: t.id,
        title: t.title,
        wordCount: t.wordCount,
        cefrLevel: t.cefrLevel,
        completedAt: t.completedAt,
      })),
    };
  }

  if (dimension === "all" || dimension === "listening") {
    const l = await getListeningStats(userId, 14, 18);
    data.listening = {
      todayMinutes: l.todayMinutes,
      weekMinutes: l.weekMinutes,
      monthMinutes: l.monthMinutes,
      totalMinutes: l.totalMinutes,
      logCount: l.logCount,
      streakDays: l.streakDays,
      bestStreak: l.bestStreak,
      activeDays: l.activeDays,
      recentLogs: l.recentLogs.slice(0, 5).map((item) => ({
        id: item.id,
        logDate: item.logDate,
        minutes: item.minutes,
        mode: item.mode,
        note: item.note,
      })),
    };
  }

  return { ok: true, data };
}

async function handleListLearningWords(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecResult> {
  const status =
    args.status === "learned" || args.status === "all" ? args.status : "learning";
  const starredOnly = args.starredOnly === true;
  const rawLimit = typeof args.limit === "number" ? Math.floor(args.limit) : 30;
  const limit = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 30));

  const conditions = [eq(userWords.userId, userId)];
  if (status !== "all") conditions.push(eq(userWords.status, status));
  if (starredOnly) conditions.push(eq(userWords.starred, 1));

  const rows = await db
    .select({
      lemma: userWords.lemma,
      displayForm: userWords.displayForm,
      pos: userWords.pos,
      translation: userWords.translation,
      status: userWords.status,
      starred: userWords.starred,
      isPhrase: userWords.isPhrase,
      createdAt: userWords.createdAt,
    })
    .from(userWords)
    .where(and(...conditions))
    .orderBy(desc(userWords.starred), desc(userWords.createdAt))
    .limit(limit);

  return {
    ok: true,
    data: {
      count: rows.length,
      status,
      starredOnly,
      words: rows.map((w) => ({
        lemma: w.lemma,
        displayForm: w.displayForm,
        pos: w.pos,
        translation: w.translation,
        status: w.status,
        starred: w.starred === 1,
        isPhrase: w.isPhrase === 1,
        createdAt: w.createdAt,
      })),
    },
  };
}

async function handleLogListening(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecResult> {
  const now = new Date();
  const parsed = validateListeningInput(
    {
      minutes: args.minutes,
      logDate: args.logDate,
      mode: args.mode,
      note: args.note,
    },
    dayKey(now),
  );
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const id = crypto.randomUUID();
  const createdAt = now.getTime();
  const { minutes, logDate, mode, note } = parsed.data;

  db.insert(listeningLogs)
    .values({
      id,
      userId,
      logDate,
      minutes,
      mode,
      note,
      source: "manual",
      textId: null,
      createdAt,
    })
    .run();

  const stats = await getListeningStats(userId, 14, 18, now);
  return {
    ok: true,
    data: {
      log: { id, logDate, minutes, mode, note },
      summary: {
        todayMinutes: stats.todayMinutes,
        weekMinutes: stats.weekMinutes,
        monthMinutes: stats.monthMinutes,
        totalMinutes: stats.totalMinutes,
        streakDays: stats.streakDays,
        bestStreak: stats.bestStreak,
      },
    },
  };
}

async function handleImportArticle(
  userId: string,
  origin: string | null,
  args: Record<string, unknown>,
): Promise<ToolExecResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  const content = typeof args.content === "string" ? args.content : "";
  const rawTitle = typeof args.title === "string" ? args.title.trim().slice(0, 200) : "";
  const category =
    typeof args.category === "string" ? args.category.trim().slice(0, 30) || null : null;

  if (!url && !content.trim()) {
    return { ok: false, error: "请提供文章正文（content）或网页链接（url）" };
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return { ok: false, error: `文章正文过长（上限 ${MAX_CONTENT_CHARS} 字符）` };
  }

  let title = rawTitle;
  let sourceType: "paste" | "url" = "paste";
  let sourceUrl: string | null = null;
  let blocks;
  let sourceFormat;
  let sourceRaw: string;

  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: "url 必须以 http:// 或 https:// 开头" };
    }
    sourceType = "url";
    sourceUrl = url;
    try {
      const extracted = await extractFromUrl(url);
      ({ blocks, sourceFormat, sourceRaw } = blocksFromExtracted(extracted, url));
      title = title || extracted.title;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "抓取网页正文失败",
      };
    }
  } else {
    const parsed = parsePasted(content, "auto");
    blocks = parsed.blocks;
    sourceFormat = parsed.format;
    sourceRaw = content;
  }

  try {
    const created = createText({
      userId,
      title,
      sourceType,
      sourceUrl,
      blocks,
      sourceFormat,
      sourceRaw,
      category,
    });
    const readPath = `/texts/${created.id}`;
    return {
      ok: true,
      data: {
        id: created.id,
        title: created.title,
        wordCount: created.wordCount,
        cefrLevel: created.cefrLevel,
        category,
        readPath,
        readUrl: origin ? `${origin}${readPath}` : readPath,
      },
    };
  } catch (err) {
    if (err instanceof EmptyTextError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

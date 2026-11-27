import { db } from "@/db";
import { listeningLogs, texts } from "@/db/schema";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { CefrDetail, CefrLevel } from "./cefr";
import {
  aggregateByPeriod,
  roundMinutes,
  type ListeningMode,
} from "./listening";
import {
  buildCalendar,
  computeStreaks,
  dayKey,
  type CalendarCell,
  type StreakResult,
} from "./streak";

export type DayStat = { date: string; count: number };

export type { CalendarCell };

export type CompletedTextItem = {
  id: string;
  title: string;
  wordCount: number;
  completedAt: number;
  cefrLevel: CefrLevel | null;
  cefrScore: number | null;
  cefrDetail: CefrDetail | null;
};

export type ReadingStats = StreakResult & {
  totalWords: number;
  todayWords: number;
  weekWords: number;
  monthWords: number;
  completedCount: number;
  recent: DayStat[];
  /** 按周对齐的热力图格子，列 = 周 */
  calendar: CalendarCell[];
  recentCompleted: CompletedTextItem[];
};

export type ListeningLogItem = {
  id: string;
  logDate: string;
  minutes: number;
  mode: ListeningMode;
  note: string | null;
  source: string;
  textId: string | null;
  createdAt: number;
};

export type ListeningStats = StreakResult & {
  totalMinutes: number;
  todayMinutes: number;
  weekMinutes: number;
  monthMinutes: number;
  logCount: number;
  recent: DayStat[];
  calendar: CalendarCell[];
  recentLogs: ListeningLogItem[];
};

function buildRecentBuckets(
  byDay: Map<string, number>,
  days: number,
  now: Date,
): DayStat[] {
  const buckets: DayStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    buckets.push({ date: key, count: roundMinutes(byDay.get(key) ?? 0) });
  }
  return buckets;
}

function parseCefrDetail(raw: string | null): CefrDetail | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CefrDetail;
  } catch {
    return null;
  }
}

/**
 * 阅读战绩（P60）：仅统计显式「标记已读完」（completedAt IS NOT NULL）且非网页摘录的文章词数。
 * 没读完的文章词数为 0；取消完读时自动扣减。
 */
export async function getReadingStats(
  userId: string,
  days = 14,
  calendarWeeks = 18,
  now = new Date(),
): Promise<ReadingStats> {
  const completedWhere = and(
    eq(texts.userId, userId),
    ne(texts.sourceType, "web"),
    isNotNull(texts.completedAt),
  );

  const [dailyRows, summaryRows, recentRows] = await Promise.all([
    db
      .select({
        d: sql<string>`date(${texts.completedAt} / 1000, 'unixepoch', 'localtime')`,
        w: sql<number>`coalesce(sum(${texts.wordCount}), 0)`,
      })
      .from(texts)
      .where(completedWhere)
      .groupBy(sql`date(${texts.completedAt} / 1000, 'unixepoch', 'localtime')`),
    db
      .select({
        c: sql<number>`count(*)`,
        w: sql<number>`coalesce(sum(${texts.wordCount}), 0)`,
      })
      .from(texts)
      .where(completedWhere),
    db
      .select({
        id: texts.id,
        title: texts.title,
        wordCount: texts.wordCount,
        completedAt: texts.completedAt,
        cefrLevel: texts.cefrLevel,
        cefrScore: texts.cefrScore,
        cefrDetail: texts.cefrDetail,
      })
      .from(texts)
      .where(completedWhere)
      .orderBy(desc(texts.completedAt))
      .limit(10),
  ]);

  const byDay = new Map<string, number>();
  for (const r of dailyRows) {
    if (r.d) byDay.set(r.d, Number(r.w));
  }

  const periods = aggregateByPeriod(byDay, now);

  return {
    totalWords: Number(summaryRows[0]?.w ?? 0),
    todayWords: Math.round(periods.todayTotal),
    weekWords: Math.round(periods.weekTotal),
    monthWords: Math.round(periods.monthTotal),
    completedCount: Number(summaryRows[0]?.c ?? 0),
    recent: buildRecentBuckets(byDay, days, now),
    calendar: buildCalendar(byDay, calendarWeeks, now),
    ...computeStreaks(byDay, now),
    recentCompleted: recentRows.map((r) => ({
      id: r.id,
      title: r.title,
      wordCount: r.wordCount,
      completedAt: r.completedAt ?? 0,
      cefrLevel: (r.cefrLevel as CefrLevel | null) ?? null,
      cefrScore: r.cefrScore ?? null,
      cefrDetail: parseCefrDetail(r.cefrDetail),
    })),
  };
}

/**
 * 听力战绩（P60）：基于 listening_logs 按天汇总净听懂时长（浮点数分钟）。
 */
export async function getListeningStats(
  userId: string,
  days = 14,
  calendarWeeks = 18,
  now = new Date(),
): Promise<ListeningStats> {
  const userWhere = eq(listeningLogs.userId, userId);

  const [dailyRows, summaryRows, recentRows] = await Promise.all([
    db
      .select({
        d: listeningLogs.logDate,
        m: sql<number>`coalesce(sum(${listeningLogs.minutes}), 0)`,
      })
      .from(listeningLogs)
      .where(userWhere)
      .groupBy(listeningLogs.logDate),
    db
      .select({
        c: sql<number>`count(*)`,
        m: sql<number>`coalesce(sum(${listeningLogs.minutes}), 0)`,
      })
      .from(listeningLogs)
      .where(userWhere),
    db
      .select()
      .from(listeningLogs)
      .where(userWhere)
      .orderBy(desc(listeningLogs.logDate), desc(listeningLogs.createdAt))
      .limit(20),
  ]);

  const byDay = new Map<string, number>();
  for (const r of dailyRows) {
    byDay.set(r.d, roundMinutes(Number(r.m)));
  }

  const periods = aggregateByPeriod(byDay, now);

  return {
    totalMinutes: roundMinutes(Number(summaryRows[0]?.m ?? 0)),
    todayMinutes: periods.todayTotal,
    weekMinutes: periods.weekTotal,
    monthMinutes: periods.monthTotal,
    logCount: Number(summaryRows[0]?.c ?? 0),
    recent: buildRecentBuckets(byDay, days, now),
    calendar: buildCalendar(byDay, calendarWeeks, now),
    ...computeStreaks(byDay, now),
    recentLogs: recentRows.map((r) => ({
      id: r.id,
      logDate: r.logDate,
      minutes: roundMinutes(r.minutes),
      mode: r.mode === "extensive" ? "extensive" : "intensive",
      note: r.note ?? null,
      source: r.source,
      textId: r.textId ?? null,
      createdAt: r.createdAt,
    })),
  };
}

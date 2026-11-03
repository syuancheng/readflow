import { db } from "@/db";
import { contexts, texts, userWords, LOCAL_USER } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  buildCalendar,
  computeStreaks,
  dayKey,
  type CalendarCell,
  type StreakResult,
} from "./streak";

export type DayStat = { date: string; count: number };

export type { CalendarCell };

export type Stats = StreakResult & {
  textCount: number;
  totalWords: number;
  savedCount: number;
  todayCount: number;
  recent: DayStat[];
  /** 按周对齐的热力图格子，列 = 周 */
  calendar: CalendarCell[];
};

/**
 * 收词日历 / 连续天数。
 *
 * `days` 只影响 recent 柱状图的窗口；streak 和日历走的是**全量**历史。
 */
export async function getStats(days = 7, calendarWeeks = 18): Promise<Stats> {
  const textRows = await db
    .select({
      c: sql<number>`count(*)`,
      w: sql<number>`coalesce(sum(${texts.wordCount}), 0)`,
    })
    .from(texts)
    .where(eq(texts.userId, LOCAL_USER));

  const wordRows = await db
    .select({ c: sql<number>`count(*)` })
    .from(userWords)
    .where(eq(userWords.userId, LOCAL_USER));

  // 通过 user_words 关联 contexts，按天聚合。
  // 这里没有日期 where —— recent / 日历 / streak 都基于这份全量数据。
  const ctxRows = await db
    .select({
      d: sql<string>`date(${contexts.createdAt} / 1000, 'unixepoch', 'localtime')`,
      c: sql<number>`count(*)`,
    })
    .from(contexts)
    .innerJoin(userWords, eq(contexts.userWordId, userWords.id))
    .where(eq(userWords.userId, LOCAL_USER))
    .groupBy(sql`date(${contexts.createdAt} / 1000, 'unixepoch', 'localtime')`);

  const byDay = new Map(ctxRows.map((r) => [r.d, Number(r.c)]));

  const dayMs = 24 * 60 * 60 * 1000;
  const buckets: DayStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(new Date(Date.now() - i * dayMs));
    buckets.push({ date: key, count: byDay.get(key) ?? 0 });
  }

  const now = new Date();

  return {
    textCount: Number(textRows[0]?.c ?? 0),
    totalWords: Number(textRows[0]?.w ?? 0),
    savedCount: Number(wordRows[0]?.c ?? 0),
    todayCount: byDay.get(dayKey(now)) ?? 0,
    recent: buckets,
    calendar: buildCalendar(byDay, calendarWeeks, now),
    ...computeStreaks(byDay, now),
  };
}

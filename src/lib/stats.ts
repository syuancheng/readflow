import { db } from "@/db";
import { contexts, texts, userWords, LOCAL_USER } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export type Stats = {
  textCount: number;
  totalWords: number;
  savedCount: number;
  todayCount: number;
  recent: { date: string; count: number }[];
};

/** 取最近 N 天的收集记录，用于画小柱状图 */
export async function getStats(days = 7): Promise<Stats> {
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

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // 通过 user_words 关联 contexts，按天聚合
  const ctxRows = await db
    .select({
      d: sql<string>`date(${contexts.createdAt} / 1000, 'unixepoch', 'localtime')`,
      c: sql<number>`count(*)`,
    })
    .from(contexts)
    .innerJoin(userWords, eq(contexts.userWordId, userWords.id))
    .where(eq(userWords.userId, LOCAL_USER))
    .groupBy(sql`date(${contexts.createdAt} / 1000, 'unixepoch', 'localtime')`);

  const dayMs = 24 * 60 * 60 * 1000;
  const buckets: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * dayMs);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const hit = ctxRows.find((r) => r.d === key);
    buckets.push({ date: key, count: Number(hit?.c ?? 0) });
  }

  const todayKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  return {
    textCount: Number(textRows[0]?.c ?? 0),
    totalWords: Number(textRows[0]?.w ?? 0),
    savedCount: Number(wordRows[0]?.c ?? 0),
    todayCount: Number(ctxRows.find((r) => r.d === todayKey)?.c ?? 0),
    recent: buckets,
  };
}

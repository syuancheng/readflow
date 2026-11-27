import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { userWords } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { getListeningStats, getReadingStats } from "@/lib/stats";
import { dayKey } from "@/lib/streak";
import StatsClient from "./StatsClient";

export const dynamic = "force-dynamic";

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login?next=/stats");

  const sp = await searchParams;
  const initialTab = sp.tab === "listening" ? "listening" : "reading";
  const now = new Date();

  const [reading, listening, wordRows] = await Promise.all([
    getReadingStats(user.id, 14, 18, now),
    getListeningStats(user.id, 14, 18, now),
    db
      .select({ id: userWords.id, displayForm: userWords.displayForm })
      .from(userWords)
      .where(eq(userWords.userId, user.id))
      .orderBy(desc(userWords.createdAt))
      .limit(8),
  ]);

  return (
    <StatsClient
      initialTab={initialTab}
      todayKey={dayKey(now)}
      reading={reading}
      initialListening={listening}
      recentWords={wordRows}
    />
  );
}

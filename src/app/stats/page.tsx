import { and, eq, desc, ne } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { texts, userWords } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { getStats } from "@/lib/stats";
import HeatCalendar, { HeatLegend } from "@/components/HeatCalendar";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export default async function StatsPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/stats");
  const [stats, textRows, wordRows] = await Promise.all([
    getStats(14, 18, user.id),
    db
      .select()
      .from(texts)
      // 网页摘录（P31）不算读过的书
      .where(and(eq(texts.userId, user.id), ne(texts.sourceType, "web")))
      .orderBy(desc(texts.createdAt)),
    db
      .select()
      .from(userWords)
      .where(eq(userWords.userId, user.id))
      .orderBy(desc(userWords.createdAt))
      .limit(8),
  ]);

  const maxBar = Math.max(1, ...stats.recent.map((r) => r.count));

  return (
    <div className="rf-container rf-page">
      {/* 页面标题由顶部导航高亮表达，这里只留一句说明（不重复写「战绩」） */}
      <p className="rf-page-desc">看看你读了多少、记住了多少。</p>

      {/* 顶部四连卡 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <BigStat
          value={stats.savedCount}
          label="收集生词"
          icon="⚡"
        />
        <BigStat
          value={stats.streakDays}
          label="连续天数"
          icon="🔥"
        />
        <BigStat
          value={stats.bestStreak}
          label="最长连续"
          icon="🏅"
        />
        <BigStat
          value={stats.textCount}
          label="读过的文本"
          icon="📚"
        />
      </div>

      {/* 学习日历 + 最近 14 天：桌面并排，日历按内容宽度，柱状图占满剩余 */}
      <div className="grid gap-6 mb-6 lg:grid-cols-[auto_minmax(0,1fr)]">
      <div className="duo-card p-6">
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div className="duo-section-title">学习日历</div>
          <HeatLegend />
        </div>

        <HeatCalendar cells={stats.calendar} />

        <p className="text-sm text-ink-soft mt-4 pt-4 border-t border-[var(--rf-border)]">
          {stats.activeDays === 0 ? (
            <>还没有收过词 —— 日历上点亮的每一格，都是你读过的一天</>
          ) : (
            <>
              共 <b className="text-ink">{stats.activeDays}</b>{" "}
              天有收词记录
              {stats.bestStreak > 1 && (
                <>
                  ，最长连续{" "}
                  <b className="text-ink">{stats.bestStreak}</b>{" "}
                  天
                </>
              )}
            </>
          )}
        </p>
      </div>

      {/* 14 天柱状图 */}
      <div className="duo-card p-6 flex flex-col">
        <div className="duo-section-title mb-4">最近 14 天</div>
        <div className="flex justify-between gap-2 flex-1 min-h-40">
          {stats.recent.map((d, i) => {
            const h = Math.round((d.count / maxBar) * 100);
            const isToday = i === stats.recent.length - 1;
            const empty = d.count === 0;
            return (
              <div key={d.date} className="flex-1 h-full flex flex-col items-center gap-1">
                <span className="text-xs font-semibold text-ink-soft min-h-4">{d.count || ""}</span>
                <div className="w-full flex-1 flex items-end">
                  <div
                    className="w-full rounded-sm"
                    style={{
                      height: `${Math.max(h, 4)}%`,
                      background: empty
                        ? "var(--rf-bg-selected)"
                        : isToday
                          ? "var(--rf-accent)"
                          : "var(--rf-heat-2)",
                    }}
                  />
                </div>
                <span
                  className="text-xs min-h-4"
                  style={{
                    color: isToday ? "var(--rf-text-primary)" : "var(--rf-text-secondary)",
                    fontWeight: isToday ? 700 : 400,
                  }}
                >
                  {i % 2 === 0 ? WEEKDAYS[new Date(d.date).getDay()] : ""}
                </span>
              </div>
            );
          })}
        </div>
        {stats.savedCount === 0 && (
          <p className="text-sm text-ink-soft text-center mt-4 pt-4 border-t border-[var(--rf-border)]">
            还没有收过词 —— 去读一篇，收集你的第一个生词吧
          </p>
        )}
      </div>
      </div>

      {/* 最近收的词 */}
      <div className="duo-card p-6 mb-6">
        <div className="duo-section-title mb-4">最近收下的词</div>
        {wordRows.length === 0 ? (
          <p className="text-sm text-ink-faint text-center py-6">
            还没有收过词，去
            <Link href="/" className="text-ink underline underline-offset-2 mx-1">
              读一篇
            </Link>
            试试
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {wordRows.map((w) => (
              <span
                key={w.id}
                className="inline-flex items-center h-8 px-3 rounded-full text-sm font-semibold"
                style={{ background: "var(--rf-bg-subtle)", color: "var(--rf-text-primary)" }}
              >
                {w.displayForm}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 读过的文本 */}
      {textRows.length > 0 && (
        <div className="duo-card p-6">
          <div className="duo-section-title mb-2">书架</div>
          <ul className="divide-y divide-[var(--rf-border)]">
            {textRows.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/texts/${t.id}`}
                  className="flex items-center justify-between gap-4 -mx-3 px-3 py-3 rounded-md hover:bg-[var(--rf-bg-hover)] transition-colors"
                >
                  <span className="text-base font-semibold truncate">{t.title}</span>
                  <span className="text-sm text-ink-soft shrink-0">
                    {t.wordCount.toLocaleString()} 词
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 统计数字卡：数字用主文字色，emoji 是唯一的游戏化点缀（规范 §1.1 / §7） */
function BigStat({ value, label, icon }: { value: number; label: string; icon: string }) {
  return (
    <div className="duo-card p-6">
      <div className="flex items-center gap-2 text-sm text-ink-soft">
        <span aria-hidden>{icon}</span>
        {label}
      </div>
      <div className="text-3xl font-extrabold mt-2">{value}</div>
    </div>
  );
}

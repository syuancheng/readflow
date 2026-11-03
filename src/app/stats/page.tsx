import { eq, desc } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { texts, userWords, LOCAL_USER } from "@/db/schema";
import { getStats } from "@/lib/stats";
import HeatCalendar, { HeatLegend } from "@/components/HeatCalendar";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export default async function StatsPage() {
  const [stats, textRows, wordRows] = await Promise.all([
    getStats(14, 18),
    db
      .select()
      .from(texts)
      .where(eq(texts.userId, LOCAL_USER))
      .orderBy(desc(texts.createdAt)),
    db
      .select()
      .from(userWords)
      .where(eq(userWords.userId, LOCAL_USER))
      .orderBy(desc(userWords.createdAt))
      .limit(8),
  ]);

  const maxBar = Math.max(1, ...stats.recent.map((r) => r.count));

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-7">
        <h1 className="text-[28px] font-extrabold tracking-tight mb-1.5">我的战绩</h1>
        <p className="text-[15px] text-ink-soft font-medium">看看你读了多少、记住了多少。</p>
      </div>

      {/* 顶部四连卡 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <BigStat
          value={stats.savedCount}
          label="收集生词"
          icon="⚡"
          color="var(--duo-green-dark)"
          bg="var(--duo-green-soft)"
        />
        <BigStat
          value={stats.streakDays}
          label="连续天数"
          icon="🔥"
          color="var(--duo-orange-dark)"
          bg="var(--duo-orange-soft)"
        />
        <BigStat
          value={stats.bestStreak}
          label="最长连续"
          icon="🏅"
          color="var(--duo-purple-dark)"
          bg="var(--duo-purple-soft)"
        />
        <BigStat
          value={stats.textCount}
          label="读过的文本"
          icon="📚"
          color="var(--duo-blue-dark)"
          bg="var(--duo-blue-soft)"
        />
      </div>

      {/* 学习日历 */}
      <div className="duo-card p-6 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div className="duo-section-title">
            <span style={{ color: "var(--duo-green)" }}>📅</span>
            学习日历
          </div>
          <HeatLegend />
        </div>

        <HeatCalendar cells={stats.calendar} />

        <p className="text-[13px] font-medium text-ink-faint mt-4 pt-4 border-t border-[var(--duo-border)]">
          {stats.activeDays === 0 ? (
            <>还没有收过词 —— 日历上点亮的每一格，都是你读过的一天</>
          ) : (
            <>
              共 <b style={{ color: "var(--duo-green-dark)" }}>{stats.activeDays}</b>{" "}
              天有收词记录
              {stats.bestStreak > 1 && (
                <>
                  ，最长连续{" "}
                  <b style={{ color: "var(--duo-purple-dark)" }}>
                    {stats.bestStreak}
                  </b>{" "}
                  天
                </>
              )}
            </>
          )}
        </p>
      </div>

      {/* 14 天柱状图 */}
      <div className="duo-card p-6 mb-6">
        <div className="duo-section-title mb-4">
          <span style={{ color: "var(--duo-purple)" }}>📈</span>
          最近 14 天
        </div>
        <div className="flex items-end justify-between gap-1 h-32">
          {stats.recent.map((d, i) => {
            const h = Math.round((d.count / maxBar) * 100);
            const isToday = i === stats.recent.length - 1;
            const empty = d.count === 0;
            return (
              <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-[10px] font-bold text-ink-faint">{d.count || ""}</span>
                <div
                  className="w-full rounded-lg"
                  style={{
                    height: `${Math.max(h, 5)}%`,
                    background: empty
                      ? "var(--duo-surface)"
                      : isToday
                        ? "var(--duo-green)"
                        : "var(--duo-blue-soft)",
                    borderBottom: empty
                      ? "3px solid var(--duo-border)"
                      : isToday
                        ? "3px solid var(--duo-green-dark)"
                        : "3px solid #b8e6ff",
                  }}
                />
                <span
                  className="text-[9px] font-bold"
                  style={{ color: isToday ? "var(--duo-green-dark)" : "var(--duo-ink-faint)" }}
                >
                  {i % 2 === 0 ? WEEKDAYS[new Date(d.date).getDay()] : ""}
                </span>
              </div>
            );
          })}
        </div>
        {stats.savedCount === 0 && (
          <p className="text-[13px] font-medium text-ink-faint text-center mt-4 pt-4 border-t border-[var(--duo-border)]">
            还没有收过词 —— 去读一篇，收集你的第一个生词吧
          </p>
        )}
      </div>

      {/* 最近收的词 */}
      <div className="duo-card p-6 mb-6">
        <div className="duo-section-title mb-4">
          <span style={{ color: "var(--duo-green)" }}>✨</span>
          最近收下的词
        </div>
        {wordRows.length === 0 ? (
          <p className="text-[14px] text-ink-faint text-center py-6">
            还没有收过词，去
            <Link href="/" className="text-ink underline underline-offset-2 mx-1">
              读一篇
            </Link>
            试试
          </p>
        ) : (
          <div className="flex flex-wrap gap-2.5">
            {wordRows.map((w) => (
              <span
                key={w.id}
                className="px-3.5 py-2 rounded-xl text-[14px] font-bold"
                style={{ background: "var(--duo-surface)", color: "var(--duo-ink)" }}
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
          <div className="duo-section-title mb-4">
            <span style={{ color: "var(--duo-blue)" }}>🗂</span>
            书架
          </div>
          <ul className="space-y-2">
            {textRows.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/texts/${t.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl hover:bg-[var(--duo-surface)] transition-colors"
                >
                  <span className="text-[15px] font-bold truncate">{t.title}</span>
                  <span className="text-[13px] font-bold text-ink-faint shrink-0">
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

function BigStat({
  value,
  label,
  icon,
  color,
  bg,
}: {
  value: number;
  label: string;
  icon: string;
  color: string;
  bg: string;
}) {
  return (
    <div className="duo-card p-5 text-center">
      <div className="text-[26px] mb-1.5">{icon}</div>
      <div className="text-[30px] font-extrabold leading-none mb-1.5" style={{ color }}>
        {value}
      </div>
      <div className="text-[12.5px] font-bold" style={{ color }}>
        {label}
      </div>
      <div className="h-1.5 rounded-full mt-2.5" style={{ background: bg }} />
    </div>
  );
}

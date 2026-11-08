import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { texts, LOCAL_USER } from "@/db/schema";
import { getStats } from "@/lib/stats";
import ImportForm from "@/components/ImportForm";
import TextList, { type TextCardRow } from "@/components/TextList";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export default async function Home() {
  const [rows, stats] = await Promise.all([
    db
      .select()
      .from(texts)
      .where(eq(texts.userId, LOCAL_USER))
      .orderBy(desc(texts.createdAt)),
    getStats(7),
  ]);

  const cards: TextCardRow[] = rows.map((t) => ({
    id: t.id,
    title: t.title,
    sourceType: t.sourceType,
    category: t.category,
    wordCount: t.wordCount,
    createdAt: t.createdAt,
    cefrLevel: t.cefrLevel,
    cefrScore: t.cefrScore,
    cefrDetail: t.cefrDetail,
    readRatio: t.readRatio,
    completedAt: t.completedAt,
  }));

  const maxBar = Math.max(1, ...stats.recent.map((r) => r.count));

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* ===== 顶部欢迎条 ===== */}
      <div className="duo-card px-7 py-6 mb-7 relative">
        <div className="relative flex items-center justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-[28px] font-extrabold tracking-tight mb-1.5">
              今天读点什么？{" "}
              <span style={{ color: "var(--duo-green)" }}>继续冒险</span>
            </h1>
            <p className="text-[15px] text-ink-soft font-medium">
              导入想读的文章，边读边查词，生词会带着原句收进词库。
            </p>
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            <span className="duo-xp">⚡ {stats.todayCount * 10} XP</span>
            <span className="duo-streak">🔥 {stats.savedCount}</span>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_340px] gap-7 items-start">
        {/* ===== 左：文本列表（筛选 / 编辑 / 删除在 TextList 内）===== */}
        <div>
          <TextList rows={cards} />

          {/* 空状态时给点游戏化引导 */}
          {rows.length === 0 && (
            <div className="duo-card p-6 mt-4">
              <div className="duo-section-title mb-3">
                <span style={{ color: "var(--duo-orange)" }}>🎮</span>
                玩法
              </div>
              <ol className="space-y-2.5">
                {[
                  ["1", "导入一篇文章", "粘贴、上传文件，或贴个网页链接"],
                  ["2", "读的时候点词", "点单词查释义，拖选可以查短语"],
                  ["3", "收进词库", "生词会连着原句一起存下来"],
                  ["4", "推到墨墨记忆卡", "一键导出，用你自己的复习计划背"],
                ].map(([n, title, desc]) => (
                  <li key={n} className="flex gap-3 items-start">
                    <span
                      className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-[12px] font-extrabold text-white"
                      style={{ background: "var(--duo-blue)" }}
                    >
                      {n}
                    </span>
                    <div>
                      <p className="text-[14.5px] font-bold">{title}</p>
                      <p className="text-[13px] text-ink-faint font-medium">{desc}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* ===== 右：导入 + 统计 ===== */}
        <div className="space-y-5 lg:sticky lg:top-24">
          <ImportForm />

          {/* 统计卡 */}
          <div className="duo-card p-6">
            <div className="duo-section-title mb-4">
              <span style={{ color: "var(--duo-purple)" }}>🏆</span>
              我的战绩
            </div>

            <div className="grid grid-cols-3 gap-3 mb-5">
              <StatBox value={stats.textCount} label="文本" color="var(--duo-blue-dark)" bg="var(--duo-blue-soft)" />
              <StatBox value={stats.savedCount} label="生词" color="var(--duo-green-dark)" bg="var(--duo-green-soft)" />
              <StatBox value={stats.todayCount} label="今日" color="var(--duo-orange-dark)" bg="var(--duo-orange-soft)" />
            </div>

            <p className="text-[12px] font-bold uppercase tracking-wide text-ink-faint mb-3">
              最近 7 天收集
            </p>
            <div className="flex items-end justify-between gap-2 h-24">
              {stats.recent.map((d, i) => {
                const h = Math.round((d.count / maxBar) * 100);
                const isToday = i === stats.recent.length - 1;
                const empty = d.count === 0;
                return (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1.5">
                    <span className="text-[11px] font-bold text-ink-faint">{d.count || ""}</span>
                    <div
                      className="w-full rounded-lg transition-all"
                      style={{
                        height: `${Math.max(h, 6)}%`,
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
                      className="text-[11px] font-bold"
                      style={{ color: isToday ? "var(--duo-green-dark)" : "var(--duo-ink-faint)" }}
                    >
                      {WEEKDAYS[new Date(d.date).getDay()]}
                    </span>
                  </div>
                );
              })}
            </div>

            <Link href="/stats" className="duo-btn duo-btn-white w-full mt-5">
              查看完整战绩
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatBox({
  value,
  label,
  color,
  bg,
}: {
  value: number;
  label: string;
  color: string;
  bg: string;
}) {
  return (
    <div
      className="rounded-xl py-3 text-center"
      style={{ background: bg }}
    >
      <div className="text-[22px] font-extrabold leading-none mb-1" style={{ color }}>
        {value}
      </div>
      <div className="text-[12px] font-bold" style={{ color }}>
        {label}
      </div>
    </div>
  );
}

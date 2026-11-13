import { and, desc, eq, ne } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { texts } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { getStats } from "@/lib/stats";
import ImportForm from "@/components/ImportForm";
import TextList, { type TextCardRow } from "@/components/TextList";
import SurveyPrompt from "@/components/SurveyPrompt";
import { getLearner, needsSurvey } from "@/lib/learner-store";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export default async function Home() {
  // proxy 只挡「没 cookie」；伪造 / 过期 cookie 在这里兜底
  const user = await currentUser();
  if (!user) redirect("/login");
  const [rows, stats] = await Promise.all([
    db
      .select()
      .from(texts)
      // P31 决策 D4：网页摘录（插件记词时顺带建的 source_type='web'）不是完整文章，
      // 不进「我的文本」书架；它的词在词库里照常见。
      .where(and(eq(texts.userId, user.id), ne(texts.sourceType, "web")))
      .orderBy(desc(texts.createdAt)),
    getStats(7, 18, user.id),
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
  // P32：没填过问卷、也没点过「以后再说」的老用户，在首页看到一次提示卡片
  const showSurvey = needsSurvey(getLearner(user.id));

  return (
    <div className="rf-container rf-page">
      {/* ===== 页面头：不套卡片（规范 §5 不嵌套框），右侧是游戏化徽章 ===== */}
      <div className="flex items-end justify-between gap-6 flex-wrap mb-8">
        <div>
          <h1 className="rf-home-hero">今天读点什么？</h1>
          <p className="text-sm text-ink-soft mt-2">
            导入想读的文章，边读边查词，生词会带着原句收进词库。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="duo-xp">⚡ {stats.todayCount * 10} XP</span>
          <span className="duo-streak">🔥 {stats.savedCount}</span>
        </div>
      </div>

      {showSurvey && <SurveyPrompt />}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-8 items-start">
        {/* ===== 左：文本列表（筛选 / 编辑 / 删除在 TextList 内）=====
            lg:pt-6 = 右栏卡片的内边距，让「我的文本」和「导入文本」两个标题落在同一水平线 */}
        <div className="lg:pt-6">
          <TextList rows={cards} />

          {/* 空状态时给点游戏化引导 */}
          {rows.length === 0 && (
            <div className="duo-card p-6 mt-4">
              <div className="duo-section-title mb-3">玩法</div>
              <ol className="space-y-3">
                {[
                  ["1", "导入一篇文章", "粘贴、上传文件，或贴个网页链接"],
                  ["2", "读的时候点词", "点单词查释义，拖选可以查短语"],
                  ["3", "收进词库", "生词会连着原句一起存下来"],
                  ["4", "推到墨墨记忆卡", "一键导出，用你自己的复习计划背"],
                ].map(([n, title, desc]) => (
                  <li key={n} className="flex gap-3 items-start">
                    <span
                      className="shrink-0 w-6 h-6 rounded-sm flex items-center justify-center text-xs font-bold"
                      style={{ background: "var(--rf-bg-selected)", color: "var(--rf-text-primary)" }}
                    >
                      {n}
                    </span>
                    <div>
                      <p className="text-sm font-bold">{title}</p>
                      <p className="text-sm text-ink-soft">{desc}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* ===== 右：导入 + 统计 ===== */}
        <div className="space-y-6 lg:sticky lg:top-24">
          <ImportForm />

          {/* 统计卡 */}
          <div className="duo-card p-6">
            <div className="duo-section-title mb-4">我的战绩</div>

            <div className="grid grid-cols-3 gap-2 mb-6">
              <StatBox value={stats.textCount} label="文本" />
              <StatBox value={stats.savedCount} label="生词" />
              <StatBox value={stats.todayCount} label="今日" />
            </div>

            <p className="text-xs font-semibold text-ink-soft mb-3">最近 7 天收集</p>
            <div className="flex justify-between gap-2 h-32">
              {stats.recent.map((d, i) => {
                const h = Math.round((d.count / maxBar) * 100);
                const isToday = i === stats.recent.length - 1;
                const empty = d.count === 0;
                return (
                  <div key={d.date} className="flex-1 h-full flex flex-col items-center gap-2">
                    <span className="text-xs font-semibold text-ink-soft min-h-4">{d.count || ""}</span>
                    <div className="w-full flex-1 flex items-end">
                      <div
                        className="w-full rounded-sm transition-all"
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
                      className="text-xs"
                      style={{
                        color: isToday ? "var(--rf-text-primary)" : "var(--rf-text-secondary)",
                        fontWeight: isToday ? 700 : 400,
                      }}
                    >
                      {WEEKDAYS[new Date(d.date).getDay()]}
                    </span>
                  </div>
                );
              })}
            </div>

            <Link href="/stats" className="duo-btn duo-btn-white w-full mt-6">
              查看完整战绩
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 首页小统计格：中性灰底 + 主文字色数字，不再每格一种颜色 */
function StatBox({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-md py-3 text-center" style={{ background: "var(--rf-bg-subtle)" }}>
      <div className="text-2xl font-extrabold">{value}</div>
      <div className="text-xs text-ink-soft">{label}</div>
    </div>
  );
}

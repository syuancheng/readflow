import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { userWords, contexts, texts, LOCAL_USER } from "@/db/schema";
import { getStats } from "@/lib/stats";
import { normalizeTranslation } from "@/lib/text";

export const dynamic = "force-dynamic";

/** 从 context 的 prefix/suffix/quote 重建完整句子 */
function sentenceOf(prefix: string, quote: string, suffix: string): string {
  const prefixSent = (prefix || "").replace(/^.*[.!?]\s*/, "");
  const suffixSent = (suffix || "").replace(/\s*[.!?].*$/, "");
  return `${prefixSent}${quote}${suffixSent}`.trim() || quote;
}

export default async function WordsPage() {
  const [stats, rows] = await Promise.all([
    getStats(7),
    db
      .select()
      .from(userWords)
      .where(eq(userWords.userId, LOCAL_USER))
      .orderBy(desc(userWords.createdAt)),
  ]);

  // 为每个词查出它的 context 记录（含原句和来源文本标题）
  const wordsWithContexts = await Promise.all(
    rows.map(async (w) => {
      const ctxs = db
        .select({
          id: contexts.id,
          quote: contexts.quote,
          prefix: contexts.prefix,
          suffix: contexts.suffix,
          aiGloss: contexts.aiGloss,
          textId: contexts.textId,
          textTitle: texts.title,
          createdAt: contexts.createdAt,
        })
        .from(contexts)
        .leftJoin(texts, eq(texts.id, contexts.textId))
        .where(eq(contexts.userWordId, w.id))
        .orderBy(desc(contexts.createdAt))
        .limit(3)
        .all();

      return {
        ...w,
        contexts: ctxs.map((c) => ({
          id: c.id,
          sentence: sentenceOf(c.prefix, c.quote, c.suffix),
          textTitle: c.textTitle ?? "",
          aiGloss: c.aiGloss,
        })),
      };
    }),
  );

  const maxBar = Math.max(1, ...stats.recent.map((r) => r.count));
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-7 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-tight mb-1.5">我的词库</h1>
          <p className="text-[15px] text-ink-soft font-medium">
            阅读时收下的词，都带着出现时的原句。
          </p>
        </div>
        <Link href="/export" className="duo-btn duo-btn-primary duo-btn-sm shrink-0">
          📤 导出到墨墨
        </Link>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-7 items-start">
        <div>
          <div className="duo-section-title mb-3">
            <span style={{ color: "var(--duo-green)" }}>⚡</span>
            已收集
            <span className="text-[13px] font-bold text-ink-faint">({rows.length})</span>
          </div>

          {rows.length === 0 ? (
            <div className="duo-card duo-empty">
              <div className="duo-empty-icon">📝</div>
              <p className="text-[17px] font-bold mb-1.5">词库还是空的</p>
              <p className="text-[14px] text-ink-faint">
                去阅读器里点几个词，收下的词会出现在这里
              </p>
              <Link href="/" className="duo-btn duo-btn-blue mt-5">
                去读一篇
              </Link>
            </div>
          ) : (
            <ul className="space-y-3">
              {wordsWithContexts.map((w) => (
                <li key={w.id} className="duo-text-item">
                  <div className="flex items-baseline justify-between gap-4 mb-1">
                    <div className="flex items-baseline gap-2">
                      <h3 className="text-[17px] font-extrabold">{w.displayForm}</h3>
                      {w.phonetic && (
                        <span className="text-[13px] font-medium text-ink-faint font-mono">
                          /{w.phonetic}/
                        </span>
                      )}
                    </div>
                    <form
                      action={`/api/words/${w.id}`}
                      method="post"
                      className="hidden"
                    >
                      <input type="hidden" name="_method" value="DELETE" />
                    </form>
                  </div>

                  {w.pos && (
                    <span className="duo-badge duo-badge-purple mb-1.5 inline-block">{w.pos}</span>
                  )}

                  <p className="text-[14px] text-ink-soft font-medium mb-2 whitespace-pre-line">
                    {normalizeTranslation(w.translation)}
                  </p>

                  {/* 上下文原句 */}
                  {w.contexts.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {w.contexts.map((c) => (
                        <div
                          key={c.id}
                          className="rounded-lg px-3 py-2 text-[13px] leading-relaxed"
                          style={{ background: "var(--duo-surface)" }}
                        >
                          <p className="text-ink-soft italic">
                            &ldquo;{c.sentence}&rdquo;
                          </p>
                          {c.textTitle && (
                            <p className="text-[11px] font-bold text-ink-faint mt-1">
                              ← {c.textTitle}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 侧栏统计 */}
        <div className="space-y-5 lg:sticky lg:top-24">
          <div className="duo-card p-6">
            <div className="duo-section-title mb-4">
              <span style={{ color: "var(--duo-orange)" }}>🔥</span>
              学习热度
            </div>

            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="rounded-xl py-3 text-center" style={{ background: "var(--duo-green-soft)" }}>
                <div className="text-[24px] font-extrabold leading-none mb-1" style={{ color: "var(--duo-green-dark)" }}>
                  {stats.savedCount}
                </div>
                <div className="text-[12px] font-bold" style={{ color: "var(--duo-green-dark)" }}>
                  总生词
                </div>
              </div>
              <div className="rounded-xl py-3 text-center" style={{ background: "var(--duo-orange-soft)" }}>
                <div className="text-[24px] font-extrabold leading-none mb-1" style={{ color: "var(--duo-orange-dark)" }}>
                  {stats.todayCount}
                </div>
                <div className="text-[12px] font-bold" style={{ color: "var(--duo-orange-dark)" }}>
                  今日
                </div>
              </div>
            </div>

            <p className="text-[12px] font-bold uppercase tracking-wide text-ink-faint mb-3">
              最近 7 天
            </p>
            <div className="flex items-end justify-between gap-2 h-24">
              {stats.recent.map((d, i) => {
                const h = Math.round((d.count / maxBar) * 100);
                const isToday = i === stats.recent.length - 1;
                return (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1.5">
                    <span className="text-[11px] font-bold text-ink-faint">{d.count || ""}</span>
                    <div
                      className="w-full rounded-lg"
                      style={{
                        height: `${Math.max(h, 6)}%`,
                        background: isToday ? "var(--duo-green)" : "var(--duo-blue-soft)",
                        borderBottom: isToday ? "3px solid var(--duo-green-dark)" : "3px solid #b8e6ff",
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
          </div>

          <Link href="/" className="duo-btn duo-btn-primary w-full">
            ← 继续阅读
          </Link>
        </div>
      </div>
    </div>
  );
}

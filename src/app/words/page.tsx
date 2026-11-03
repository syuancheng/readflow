import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { userWords, contexts, paragraphs, texts, LOCAL_USER } from "@/db/schema";
import { getStats } from "@/lib/stats";
import { resolveAnchor } from "@/lib/tokenize";
import { sentenceAround } from "@/lib/split";
import WordList, { type WordRow } from "@/components/WordList";

export const dynamic = "force-dynamic";

/**
 * 兜底：从 context 的 prefix/suffix/quote 拼一句。
 * 只在锚点定位失败（文本被重新导入过）时才退化到这里。
 */
function sentenceOf(prefix: string, quote: string, suffix: string): string {
  const prefixSent = (prefix || "").replace(/^.*[.!?]\s*/, "");
  const suffixSent = (suffix || "").replace(/\s*[.!?].*$/, "");
  return `${prefixSent}${quote}${suffixSent}`.trim() || quote;
}

/** 回段落原文按句读扩成整句，和 /api/export 用同一套逻辑。 */
function fullSentence(c: {
  paraContent: string | null;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}): string | null {
  if (!c.paraContent) return null;
  const hit = resolveAnchor(c.paraContent, {
    start: c.start,
    end: c.end,
    quote: c.quote,
    prefix: c.prefix,
    suffix: c.suffix,
  });
  if (!hit) return null;
  return sentenceAround(c.paraContent, hit.start, hit.end).sentence;
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

  // 为每个词查出它的 context 记录（含原句、来源文本与段落 id —— 段落 id 用于"跳到原文"）。
  // better-sqlite3 是同步驱动，所以这里没有 await，也不用 Promise.all。
  const words: WordRow[] = rows.map((w) => {
    const ctxs = db
      .select({
        id: contexts.id,
        quote: contexts.quote,
        prefix: contexts.prefix,
        suffix: contexts.suffix,
        start: contexts.start,
        end: contexts.end,
        aiGloss: contexts.aiGloss,
        textId: contexts.textId,
        paragraphId: contexts.paragraphId,
        textTitle: texts.title,
        paraContent: paragraphs.content,
        createdAt: contexts.createdAt,
      })
      .from(contexts)
      .leftJoin(texts, eq(texts.id, contexts.textId))
      .leftJoin(paragraphs, eq(paragraphs.id, contexts.paragraphId))
      .where(eq(contexts.userWordId, w.id))
      .orderBy(desc(contexts.createdAt))
      .limit(3)
      .all();

    return {
      id: w.id,
      lemma: w.lemma,
      displayForm: w.displayForm,
      phonetic: w.phonetic,
      pos: w.pos,
      translation: w.translation,
      status: w.status,
      starred: w.starred,
      isPhrase: w.isPhrase,
      contexts: ctxs.map((c) => ({
        id: c.id,
        // 回原文按句读扩成整句；定位不到（文本被重新导入过）才退回锚点窗口
        sentence: fullSentence(c) ?? sentenceOf(c.prefix, c.quote, c.suffix),
        textId: c.textId,
        paragraphId: c.paragraphId,
        textTitle: c.textTitle ?? "",
      })),
    };
  });

  const maxBar = Math.max(1, ...stats.recent.map((r) => r.count));
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-7 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-tight mb-1.5">我的词库</h1>
          <p className="text-[15px] text-ink-soft font-medium">
            阅读时点过的词都在这里，带着原句，可跳回原文定位。
          </p>
        </div>
        <Link href="/export" className="duo-btn duo-btn-primary duo-btn-sm shrink-0">
          📤 导出到墨墨
        </Link>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-7 items-start">
        <div>
          <WordList words={words} />
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

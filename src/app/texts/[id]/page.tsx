import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { paragraphs, texts, userWords, contexts, LOCAL_USER } from "@/db/schema";
import ReaderShell from "@/components/ReaderShell";

export const dynamic = "force-dynamic";

export default async function TextPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [text] = await db.select().from(texts).where(eq(texts.id, id)).limit(1);
  if (!text) notFound();

  const rows = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.textId, id))
    .orderBy(asc(paragraphs.idx));

  // 查出这篇文章里已收的词（用于高亮）
  const savedRows = db
    .select({
      lemma: userWords.lemma,
      displayForm: userWords.displayForm,
    })
    .from(userWords)
    .innerJoin(contexts, eq(contexts.userWordId, userWords.id))
    .where(eq(contexts.textId, id))
    .all();

  // 按 lemma 去重
  const savedSet = new Set(
    savedRows.map((r) => r.lemma.toLowerCase()),
  );

  // 每日目标：按文本长度的 5% 算，最少 20 词
  const goal = Math.max(20, Math.round(text.wordCount * 0.05));

  return (
    <div className="max-w-3xl mx-auto px-6 py-7">
      <div className="mb-6">
        <Link href="/" className="duo-nav-link inline-block">
          ← 返回我的文本
        </Link>
        <h1 className="text-[28px] font-extrabold tracking-tight mt-3 mb-2">{text.title}</h1>
        <p className="text-[14px] font-medium text-ink-faint flex items-center gap-2 flex-wrap">
          <span className="duo-badge duo-badge-green">{text.wordCount.toLocaleString()} 词</span>
          <span className="duo-badge duo-badge-blue">{rows.length} 段</span>
          {text.sourceUrl && (
            <a
              href={text.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-ink-faint hover:text-ink-soft underline underline-offset-2"
            >
              查看原文
            </a>
          )}
        </p>
      </div>

      <ReaderShell
        textId={id}
        paragraphs={rows.map((r) => ({ id: r.id, idx: r.idx, content: r.content }))}
        savedLemmas={savedSet}
        goal={goal}
      />

      <p className="text-center text-[13px] font-bold text-ink-faint mt-6">
        点单词查词 · 拖选可查短语 · Esc 关闭
      </p>
    </div>
  );
}

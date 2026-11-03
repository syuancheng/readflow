import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { paragraphs, texts, userWords, LOCAL_USER } from "@/db/schema";
import ReaderShell from "@/components/ReaderShell";
import type { SavedWordInfo } from "@/components/Reader";

export const dynamic = "force-dynamic";

export default async function TextPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ p?: string }>;
}) {
  const { id } = await params;
  const { p } = await searchParams;

  const [text] = await db.select().from(texts).where(eq(texts.id, id)).limit(1);
  if (!text) notFound();

  const rows = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.textId, id))
    .orderBy(asc(paragraphs.idx));

  // 已收词（全量，不只本文——对齐 Readlang：任何文本里收过的词都高亮）。
  // 软删除的（status=deleted）不高亮、不自动弹出旧释义。
  const savedWords: SavedWordInfo[] = db
    .select({
      id: userWords.id,
      lemma: userWords.lemma,
      displayForm: userWords.displayForm,
      translation: userWords.translation,
      status: userWords.status,
      starred: userWords.starred,
    })
    .from(userWords)
    .where(eq(userWords.userId, LOCAL_USER))
    .all()
    .filter((w) => w.status !== "deleted");

  // 每日目标进度条已按用户要求移除

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-7">
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
        savedWords={savedWords}
        focusParaId={p}
      />

      <p className="text-center text-[13px] font-bold text-ink-faint mt-6">
        点单词或拖选一句话 · 释义显示在右侧批注栏 · 再点一次收起 · Esc 关闭
      </p>
    </div>
  );
}

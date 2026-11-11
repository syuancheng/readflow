import { asc, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { paragraphs, texts, userWords } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import ReaderShell from "@/components/ReaderShell";
import ReadingChrome from "@/components/ReadingChrome";
import { asCefrLevel, parseCefrDetail } from "@/lib/cefr";
import { parseBlockMeta, parseInlineRanges } from "@/lib/import/types";
import { shouldAutoResume } from "@/lib/read-progress";
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

  const user = await currentUser();
  if (!user) redirect(`/login?next=/texts/${id}`);

  const [text] = await db.select().from(texts).where(eq(texts.id, id)).limit(1);
  // 用 404 而不是 403：不向别的账号暴露「这篇文章存在」
  if (!text || text.userId !== user.id) notFound();

  const rows = await db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.textId, id))
    .orderBy(asc(paragraphs.idx));

  // 已收词（全量，不只本文——对齐 Readlang：任何文本里收过的词都高亮）。
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
    .where(eq(userWords.userId, user.id))
    .all();

  // 每日目标进度条已按用户要求移除

  // 阅读进度（P6b / P18）：优先用词库「跳到原文」的 ?p= 定位；
  // 没有显式目标时按 read_idx 自动续读。文末书签 / 100% / 已读完都不续读，
  // 否则打开就跳到文末 → 一上来 100% → 又写回 100%，进度被锁死。
  const maxIdx = rows.length > 0 ? rows[rows.length - 1].idx : -1;
  const canResume = shouldAutoResume({
    completedAt: text.completedAt,
    readIdx: text.readIdx,
    readRatio: text.readRatio,
    maxIdx,
  });
  const resumeParaId = p
    ? p
    : canResume
      ? (rows.find((r) => r.idx === text.readIdx)?.id ?? undefined)
      : undefined;

  const paraList = rows.map((r) => ({
    id: r.id,
    idx: r.idx,
    content: r.content,
    blockType: r.blockType,
    blockMeta: parseBlockMeta(r.blockMeta),
    inlineRanges: parseInlineRanges(r.inlineRanges),
  }));

  // 目录树：Block IR 里已有 heading 块与 blockMeta.depth，直接筛出来即可，
  // 不需要额外算法、模型调用或新增字段。id 就是 Reader 渲染的 data-pid。
  const headings = rows
    .filter((r) => r.blockType === "heading")
    .map((r) => ({
      id: r.id,
      depth: parseBlockMeta(r.blockMeta)?.depth ?? 2,
      text: r.content,
    }));

  return (
    <ReadingChrome
      textId={id}
      title={text.title}
      wordCount={text.wordCount}
      blockCount={rows.length}
      category={text.category}
      sourceUrl={text.sourceUrl}
      cefrLevel={asCefrLevel(text.cefrLevel)}
      cefrScore={text.cefrScore ?? null}
      cefrDetail={parseCefrDetail(text.cefrDetail)}
      initialRatio={text.readRatio}
      initialCompletedAt={text.completedAt}
      headings={headings}
    >
      <ReaderShell
        textId={id}
        paragraphs={paraList}
        savedWords={savedWords}
        focusParaId={resumeParaId}
      />
      <p className="text-center text-sm font-bold text-ink-faint mt-6">
        点单词或拖选一句话 · 释义显示在右侧批注栏 · 再点一次收起 · Esc 关闭
      </p>
    </ReadingChrome>
  );
}

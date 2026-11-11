import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { userWords, contexts, paragraphs, texts, exports } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { resolveAnchor } from "@/lib/tokenize";
import { sentenceAround } from "@/lib/split";
import WordList, { type WordRow } from "@/components/WordList";
import { latestArticle, contextsOfArticle, articleOptions, exportBadges, snippetAround } from "@/lib/word-library";
import { inlineGloss, shortGloss } from "@/lib/gloss";

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
  const user = await currentUser();
  if (!user) redirect("/login?next=/words");
  const rows = db
    .select()
    .from(userWords)
    .where(eq(userWords.userId, user.id))
    .orderBy(desc(userWords.createdAt))
    .all();

  // 导出记录一次查完（exports 没有 user_id，经 user_words 关联只取自己的），按词分组
  const exportRows = db
    .select({
      userWordId: exports.userWordId,
      target: exports.target,
      cardType: exports.cardType,
      status: exports.status,
    })
    .from(exports)
    .innerJoin(userWords, eq(exports.userWordId, userWords.id))
    .where(eq(userWords.userId, user.id))
    .all();
  const exportsByWord = new Map<string, typeof exportRows>();
  for (const r of exportRows) {
    const list = exportsByWord.get(r.userWordId) ?? [];
    list.push(r);
    exportsByWord.set(r.userWordId, list);
  }

  // 每个词查出全部语境（含原句、来源文本与段落 id —— 段落 id 用于"跳到原文"）。
  // 词只归到最近查它的那篇文章（P27），原句也只展示那篇里的。
  // better-sqlite3 是同步驱动，所以这里没有 await，也不用 Promise.all。
  const items = rows.map((w) => {
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
      .all();
    const article = latestArticle(ctxs);
    const shown = contextsOfArticle(ctxs, article);

    const row: WordRow = {
      id: w.id,
      lemma: w.lemma,
      displayForm: w.displayForm,
      phonetic: w.phonetic,
      pos: w.pos,
      translation: w.translation,
      starred: w.starred,
      isPhrase: w.isPhrase,
      articleKey: article?.key ?? null,
      lastAt: ctxs[0]?.createdAt ?? w.createdAt,
      exported: exportBadges(exportsByWord.get(w.id) ?? []),
      // 词表一行里的简短中文：和阅读页上方那行中文同一套「最直接释义」，取不到再退回词典首行
      meaning: inlineGloss(shown[0]?.aiGloss, w.translation, 16) || shortGloss(w.translation, 16),
      contexts: shown.map((c) => {
        // 回原文按句读扩成整句；定位不到（文本被重新导入过）才退回锚点窗口。
        // 文章删除后 paragraphs 也随外键级联没了，sentenceOf 的兜底同样生效。
        const sentence = fullSentence(c) ?? sentenceOf(c.prefix, c.quote, c.suffix);
        return {
        id: c.id,
        sentence,
        snippet: snippetAround(sentence, c.quote),
        textId: c.textId,
        paragraphId: c.paragraphId,
        textTitle: c.textTitle ?? "",
        // leftJoin 拿不到标题即文章已删（texts.title 恒非空）；
        // 原句与 AI 释义仍展示，只是不再提供跳转
        textDeleted: !c.textTitle,
        };
      }),
    };
    return { row, article };
  });
  const words = items.map((i) => i.row);
  const articles = articleOptions(items.map((i) => ({ article: i.article, lastAt: i.row.lastAt })));

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-[28px] font-extrabold tracking-tight mb-1.5">我的词库</h1>
        <p className="text-[15px] text-ink-soft font-medium">
          阅读时点过的词都在这里，带着原句，可跳回原文定位。点一行看完整释义。
        </p>
      </div>

      <WordList words={words} articles={articles} />
    </div>
  );
}

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { sqlite } from "@/db/sqlite";
import { activeJobId, KEY_CHAPTER, KEY_DECK, KEY_MODE } from "@/lib/cards/pusher";
import { markjiTokenFor } from "@/lib/user-secrets";
import { ownSetting } from "@/lib/cards/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cards/pending（P33 spec §7.4）
 * 返回所有有草稿卡的词（status='draft'），按文章分组。待推送列表用。
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const rows = sqlite
    .prepare(
      `SELECT k.id AS card_id, k.set_id, k.seq, k.needs_review, k.edited, k.created_at,
              s.user_word_id, s.context_id, s.text_id, s.status AS set_status,
              w.lemma, w.display_form, w.phonetic, w.is_phrase,
              t.title AS text_title
         FROM cards k
         JOIN card_sets s ON s.id = k.set_id
         JOIN user_words w ON w.id = s.user_word_id
         LEFT JOIN texts t ON t.id = s.text_id
        WHERE k.user_id = ? AND k.status = 'draft'
        ORDER BY k.created_at DESC`,
    )
    .all(user.id) as
    | {
        card_id: string; set_id: string; seq: number; needs_review: string | null;
        edited: number; created_at: number; user_word_id: string; context_id: string;
        text_id: string; set_status: string; lemma: string; display_form: string;
        phonetic: string | null; is_phrase: number; text_title: string | null;
      }[]
    | undefined;

  // 按文章分组
  const byText = new Map<string, { textId: string; title: string; words: Map<string, WordSummary> }>();
  for (const r of rows ?? []) {
    const g = byText.get(r.text_id) ?? {
      textId: r.text_id,
      title: r.text_title ?? "（文章已删除）",
      words: new Map(),
    };
    const w = g.words.get(r.user_word_id) ?? {
      wordId: r.user_word_id,
      lemma: r.lemma,
      displayForm: r.display_form,
      phonetic: r.phonetic,
      isPhrase: r.is_phrase === 1,
      cards: [],
    };
    w.cards.push({
      cardId: r.card_id,
      setId: r.set_id,
      seq: r.seq,
      needsReview: r.needs_review,
      edited: r.edited === 1,
    });
    g.words.set(r.user_word_id, w);
    byText.set(r.text_id, g);
  }

  const texts = [...byText.values()].map((g) => ({
    textId: g.textId,
    title: g.title,
    words: [...g.words.values()].map((w) => ({
      ...w,
      cards: [...w.cards].sort((a, b) => a.seq - b.seq),
    })),
  }));

  const total = (rows ?? []).length;
  // 推送栏要用的：上次选的牌组 / 章节、正在跑的任务（刷新页面后接着看进度）、有没有配墨墨 Token
  const defaults = {
    deckId: ownSetting(KEY_DECK, user.id),
    chapterId: ownSetting(KEY_CHAPTER, user.id),
    chapterMode: ownSetting(KEY_MODE, user.id) === "per_article" ? "per_article" : "fixed",
  };
  return NextResponse.json({
    texts,
    total,
    /** 有草稿卡的词数：词库「待推送 (N)」显示它（列表一行是一个词） */
    wordCount: new Set((rows ?? []).map((r) => r.user_word_id)).size,
    defaults,
    activeJobId: activeJobId(user.id),
    markjiConfigured: markjiTokenFor(user) !== null,
  });
}

type WordSummary = {
  wordId: string;
  lemma: string;
  displayForm: string;
  phonetic: string | null;
  isPhrase: boolean;
  cards: { cardId: string; setId: string; seq: number; needsReview: string | null; edited: boolean }[];
};

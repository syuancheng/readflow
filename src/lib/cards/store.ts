/**
 * 做卡相关的数据库读取（P33）。generate / 各 API 路由共用，避免每个文件各抄一份。
 * 这个文件会碰数据库，不属于「纯函数」目录里要单测编译的部分。
 */
import { sqlite } from "@/db/sqlite";
import { GLOBAL_USER } from "@/db/ensure-auth";
import { charLimitFor, listeningEnabled } from "./flags";
import { cardQuotaDay } from "./quota";

/** 站级 cards.* 开关（owner 在设置里改，所有人共用） */
export function siteCardsSettings(): Record<string, string> {
  const rows = sqlite
    .prepare("SELECT key, value FROM settings WHERE user_id = ? AND key LIKE 'cards.%'")
    .all(GLOBAL_USER) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * 这个用户自己的墨墨会员档位。**只读自己的那一行**，不回退站级：
 * 站级那行是 owner 的，别人的卡不能按 owner 的会员算字数上限。
 */
export function userMembership(userId: string): string | null {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'markji.membership'")
    .get(userId) as { value: string } | undefined;
  return row?.value ?? null;
}

export function charLimitOfUser(userId: string): number {
  return charLimitFor(userMembership(userId));
}

export function listeningOn(): boolean {
  return listeningEnabled(siteCardsSettings());
}

/** 一条批注 + 它所在的词、文章（按用户归属过滤） */
export type CardContext = {
  id: string;
  text_id: string;
  quote: string;
  prefix: string;
  suffix: string;
  word_id: string;
  lemma: string;
  display_form: string;
  translation: string;
  ai_gloss: string | null;
  text_title: string | null;
};

export function loadCardContext(userId: string, contextId: string): CardContext | undefined {
  return sqlite
    .prepare(
      `SELECT c.id, c.text_id, c.quote, c.prefix, c.suffix, c.ai_gloss,
              w.id AS word_id, w.lemma, w.display_form, w.translation,
              t.title AS text_title
         FROM contexts c
         JOIN user_words w ON w.id = c.user_word_id
         LEFT JOIN texts t ON t.id = c.text_id
        WHERE c.id = ? AND w.user_id = ?`,
    )
    .get(contextId, userId) as CardContext | undefined;
}

/** 所在句子（buildAnchor 的 prefix + quote + suffix，spec §5.1） */
export function sentenceOf(c: { prefix: string; quote: string; suffix: string }): string {
  return `${c.prefix}${c.quote}${c.suffix}`.trim() || c.quote;
}

export function cardsUsedToday(userId: string): number {
  const row = sqlite
    .prepare("SELECT count FROM card_usage WHERE user_id = ? AND day = ?")
    .get(userId, cardQuotaDay()) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function reserveQuota(userId: string, day: string): void {
  sqlite
    .prepare(
      `INSERT INTO card_usage (user_id, day, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`,
    )
    .run(userId, day);
}

/** 失败不计数：把预占的名额还回去（spec §7.3 第 9 步） */
export function refundQuota(userId: string, day: string): void {
  sqlite
    .prepare("UPDATE card_usage SET count = MAX(0, count - 1) WHERE user_id = ? AND day = ?")
    .run(userId, day);
}

/** 这个词（按词形还原）是否已有推送成功的卡片 */
export function hasPushedCards(userId: string, wordId: string): boolean {
  return (
    sqlite
      .prepare(
        `SELECT 1 FROM cards k JOIN card_sets s ON s.id = k.set_id
          WHERE k.user_id = ? AND s.user_word_id = ? AND k.status = 'pushed' LIMIT 1`,
      )
      .get(userId, wordId) !== undefined
  );
}

/** 这个词在别的文章里查过几次（按 text_id 去重） */
export function otherTextLookups(userId: string, lemma: string, textId: string): number {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT c.text_id AS tid FROM contexts c JOIN user_words w ON w.id = c.user_word_id
        WHERE w.user_id = ? AND w.lemma = ? AND c.text_id != ?`,
    )
    .all(userId, lemma.toLowerCase(), textId) as { tid: string }[];
  return rows.length;
}

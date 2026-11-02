import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 本地单机版固定使用 "local"。
 * 上云做多人时，这里替换为真实用户 id，表结构不需要改动。
 */
export const LOCAL_USER = "local";

export const texts = sqliteTable("texts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().default(LOCAL_USER),
  title: text("title").notNull(),
  sourceType: text("source_type").notNull(), // paste | file | url
  sourceUrl: text("source_url"),
  language: text("language").notNull().default("en"),
  wordCount: integer("word_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const paragraphs = sqliteTable(
  "paragraphs",
  {
    id: text("id").primaryKey(),
    textId: text("text_id")
      .notNull()
      .references(() => texts.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    content: text("content").notNull(),
  },
  (t) => [index("idx_paragraphs_text").on(t.textId, t.idx)],
);

export const userWords = sqliteTable(
  "user_words",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().default(LOCAL_USER),
    lemma: text("lemma").notNull(),
    displayForm: text("display_form").notNull(),
    pos: text("pos"),
    phonetic: text("phonetic"),
    translation: text("translation").notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_user_words_lemma").on(t.userId, t.lemma)],
);

export const contexts = sqliteTable(
  "contexts",
  {
    id: text("id").primaryKey(),
    userWordId: text("user_word_id")
      .notNull()
      .references(() => userWords.id, { onDelete: "cascade" }),
    textId: text("text_id").notNull(),
    paragraphId: text("paragraph_id").notNull(),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
    quote: text("quote").notNull(),
    prefix: text("prefix").notNull(),
    suffix: text("suffix").notNull(),
    aiGloss: text("ai_gloss"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_contexts_word").on(t.userWordId),
    index("idx_contexts_para").on(t.paragraphId),
  ],
);

/**
 * 导出去重键。
 *
 * 墨墨开放 API 没有删除端点，写进去的卡片只能在 App 端手删 ——
 * 所以「同一个词 + 同一个牌组 + 同一种卡片」必须只能成功推一次，
 * 这个唯一索引就是幂等的物理保证（不是靠代码里的 if 判断）。
 */
export const exports = sqliteTable(
  "exports",
  {
    id: text("id").primaryKey(),
    userWordId: text("user_word_id")
      .notNull()
      .references(() => userWords.id, { onDelete: "cascade" }),
    deckId: text("deck_id").notNull(),
    chapterId: text("chapter_id"),
    cardId: text("card_id"),
    /** qa=看词猜义 | cloze=挖空填空 | choice=选择题 */
    cardType: text("card_type").notNull().default("qa"),
    status: text("status").notNull().default("pending"), // pending | done | failed
    error: text("error"),
    pushedAt: integer("pushed_at"),
  },
  (t) => [uniqueIndex("uq_exports_word_deck_type").on(t.userWordId, t.deckId, t.cardType)],
);

/** 键值配置：当前只存墨墨导出的目标牌组 / 章节，将来放任何单值设置 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type Text = typeof texts.$inferSelect;
export type Paragraph = typeof paragraphs.$inferSelect;
export type UserWord = typeof userWords.$inferSelect;
export type Context = typeof contexts.$inferSelect;
export type ExportRow = typeof exports.$inferSelect;

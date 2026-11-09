import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

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
  /**
   * 导入时算一次的 CEFR 粗估（见 src/lib/cefr.ts）。
   * 全部可空：词典没装、非英文、文本太短时写 null，前端就不显示徽章。
   * 分数存连续值而不是只存级别 —— 算法以后重新校准时可以不用重读原文就重算。
   */
  cefrLevel: text("cefr_level"),
  cefrScore: real("cefr_score"),
  /** CefrDetail 的 JSON 字符串，供徽章弹层展示各档词汇占比与判定明细 */
  cefrDetail: text("cefr_detail"),
  cefrMethod: text("cefr_method"),
  /** 用户手改过级别后为 1，算法升级时不再覆盖 */
  cefrOverridden: integer("cefr_overridden").notNull().default(0),
  /**
   * 导入源与原始内容。存 source_raw 是因为上一版只存了「压平后的纯文本」，
   * 结果表格换行被 normalize() 吃掉后无法重解析，旧文章只能让用户重新导入。
   * 有原始源，以后换解析器可以直接重跑，不必再麻烦用户。
   */
  sourceFormat: text("source_format").notNull().default("plain"),
  sourceRaw: text("source_raw"),
  /**
   * 用户自定分类（技术文档 / 文学 / 博客 / 新闻 / 论文 / 教程 / 其他，
   * 或自定义字符串）。可空 = 未分类。存自由字符串而不是外键表：
   * 单用户应用不需要归一化，将来换分类体系只改前端映射，不动数据。
   */
  category: text("category"),
  /**
   * 阅读进度（P6b / P18 修订）。
   * read_idx   = 上次离开时读到的段落 idx（续读书签）；
   * read_ratio = 0–1 的滚动位置比例（实时、可下降，滚到底＝1；冗余存一份，
   *   让列表页不 join paragraphs 就能出徽章）。
   * 两列都是「位置估算」，覆盖写、不再单调合并 —— 否则一旦误写 1.0 就
   * 永远降不回来（P18 修的正是这个 bug）。可空 = 还没读过。
   */
  readIdx: integer("read_idx"),
  readRatio: real("read_ratio"),
  /**
   * 是否已读完（P18）：用户显式点「标记已读完」才写入时间戳，可空＝未标记。
   * 与 read_ratio 完全解耦：滚到 100% 不等于读完；按钮再点一次传 null 取消。
   * 不做「重置」按钮 —— 进度可下降 + 完成状态可取消已经覆盖所有修正路径。
   */
  completedAt: integer("completed_at"),
});

export const paragraphs = sqliteTable(
  "paragraphs",
  {
    id: text("id").primaryKey(),
    textId: text("text_id")
      .notNull()
      .references(() => texts.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    /**
     * 用户可见的纯文本，不含 Markdown / HTML 标记。
     * 它是 contexts.start/end 唯一的坐标基准，也是 tokenize() 的输入。
     */
    content: text("content").notNull(),
    /** Block IR：块类型 + 组装元数据 + inline 样式区间（后两者是 JSON 字符串） */
    blockType: text("block_type").notNull().default("paragraph"),
    blockMeta: text("block_meta"),
    inlineRanges: text("inline_ranges"),
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
    /**
     * 收词状态（对齐 Readlang 的词表状态机）：
     * learning = 学习中（默认） | learned = 已掌握（手动标记）
     * 没有软删除——删除一律物理删（连同 contexts / exports）。
     * 用户删词 = 已掌握，想再学就再查一遍，重新收。
     */
    status: text("status").notNull().default("learning"),
    /** 星标：手动挑出的重点词 */
    starred: integer("starred").notNull().default(0),
    /** 是否短语（含空格）。存列而不是运行时推导，方便词库里按类型筛选 */
    isPhrase: integer("is_phrase").notNull().default(0),
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

/**
 * 键值配置（P20 改为「站级默认 + 用户覆盖」）。
 * user_id = GLOBAL_USER("local") 是站级密钥（AI / 墨墨 / 插件），不是任何账号；
 * 真实账号用自己的 id 存同名 key 覆盖。读写规则见 lib/settings-store.ts。
 */
export const settings = sqliteTable(
  "settings",
  {
    userId: text("user_id").notNull().default(LOCAL_USER),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** 本地账户。密码是 scrypt 哈希串，绝不存明文；is_owner 只有 /setup 的首个账号为 1。 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  isOwner: integer("is_owner").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

/** 会话。只存 token 的 sha256，DB 泄露也无法冒用；过期由 currentUser() 校验。 */
export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * 分段小结（section summary）。
 *
 * 标记按累计词数落在自然段末尾（绝不拆段），一个区间的身份由
 * (text_id, end_idx) 决定：同一篇文章、同一个结束段落 = 同一个区间。
 * 正文入库后不再变动，所以缓存永久有效；「重新生成」就是覆盖写。
 */
export const sectionSummaries = sqliteTable(
  "section_summaries",
  {
    id: text("id").primaryKey(),
    textId: text("text_id")
      .notNull()
      .references(() => texts.id, { onDelete: "cascade" }),
    /** 区间起始段落 idx（含） */
    startIdx: integer("start_idx").notNull(),
    /** 区间结束段落 idx（含）——标记落在这一段之后 */
    endIdx: integer("end_idx").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_section_summaries_text_end").on(t.textId, t.endIdx)],
);

export type Text = typeof texts.$inferSelect;
export type Paragraph = typeof paragraphs.$inferSelect;
export type UserWord = typeof userWords.$inferSelect;
export type Context = typeof contexts.$inferSelect;
export type ExportRow = typeof exports.$inferSelect;

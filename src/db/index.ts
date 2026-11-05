import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { sqlite, dbPath } from "./sqlite";
import { ensureCefrColumns } from "./ensure-cefr";
import { ensureBlockColumns } from "./ensure-blocks";

/**
 * 建表语句直接内联：本地单机应用，启动即可用，不依赖 migration 流程。
 * 与 schema.ts 一一对应，改动时两处同步。
 *
 * 热重载可能让多个模块同时执行到这里，CREATE TABLE IF NOT EXISTS 本身幂等，
 * 但并发写会撞锁，所以失败时重试。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS texts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  cefr_level TEXT,
  cefr_score REAL,
  cefr_detail TEXT,
  cefr_method TEXT,
  cefr_overridden INTEGER NOT NULL DEFAULT 0,
  source_format TEXT NOT NULL DEFAULT 'plain',
  source_raw TEXT
);

CREATE TABLE IF NOT EXISTS paragraphs (
  id TEXT PRIMARY KEY,
  text_id TEXT NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  block_type TEXT NOT NULL DEFAULT 'paragraph',
  block_meta TEXT,
  inline_ranges TEXT
);
CREATE INDEX IF NOT EXISTS idx_paragraphs_text ON paragraphs(text_id, idx);

CREATE TABLE IF NOT EXISTS user_words (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  lemma TEXT NOT NULL,
  display_form TEXT NOT NULL,
  pos TEXT,
  phonetic TEXT,
  translation TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'learning',
  starred INTEGER NOT NULL DEFAULT 0,
  is_phrase INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_words_lemma ON user_words(user_id, lemma);

CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  user_word_id TEXT NOT NULL REFERENCES user_words(id) ON DELETE CASCADE,
  text_id TEXT NOT NULL,
  paragraph_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  quote TEXT NOT NULL,
  prefix TEXT NOT NULL,
  suffix TEXT NOT NULL,
  ai_gloss TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contexts_word ON contexts(user_word_id);
CREATE INDEX IF NOT EXISTS idx_contexts_para ON contexts(paragraph_id);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  user_word_id TEXT NOT NULL REFERENCES user_words(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL,
  chapter_id TEXT,
  card_id TEXT,
  card_type TEXT NOT NULL DEFAULT 'qa',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  pushed_at INTEGER
);
-- 唯一索引不写在这里：老库的 exports 还没有 card_type 列，
-- 要先 ALTER 加列再建索引，统一放到下面的 migrate() 里做。

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS section_summaries (
  id TEXT PRIMARY KEY,
  text_id TEXT NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
  start_idx INTEGER NOT NULL,
  end_idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_section_summaries_text_end
  ON section_summaries(text_id, end_idx);
`;

let lastError: unknown;
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    sqlite.exec(SCHEMA_SQL);
    lastError = undefined;
    break;
  } catch (err) {
    lastError = err;
    // 指数退避重试，最长等待约 1.5s
    const wait = 100 * 2 ** attempt;
    const until = Date.now() + wait;
    while (Date.now() < until) {
      /* busy wait */
    }
  }
}
if (lastError) throw lastError;

/**
 * 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，
 * 而 exports 早期版本没有 card_type（唯一键是 word+deck）。
 * 这一步把旧库升到「word+deck+card_type」的唯一键，可以重复执行。
 */
function migrate(): void {
  // user_words：2026-11 Readlang 对齐改造新增的列（老库 ALTER 补齐）
  const wordCols = sqlite.prepare("PRAGMA table_info(user_words)").all() as { name: string }[];
  if (!wordCols.some((c) => c.name === "status")) {
    sqlite.exec("ALTER TABLE user_words ADD COLUMN status TEXT NOT NULL DEFAULT 'learning'");
  }
  if (!wordCols.some((c) => c.name === "starred")) {
    sqlite.exec("ALTER TABLE user_words ADD COLUMN starred INTEGER NOT NULL DEFAULT 0");
  }
  if (!wordCols.some((c) => c.name === "is_phrase")) {
    sqlite.exec("ALTER TABLE user_words ADD COLUMN is_phrase INTEGER NOT NULL DEFAULT 0");
  }

  // texts：2026-11 新增的 CEFR 粗估字段（与回填脚本共用定义）
  ensureCefrColumns(sqlite);
  // 结构化导入：texts.source_* + paragraphs.block_*（与离线脚本共用定义）
  ensureBlockColumns(sqlite);

  const cols = sqlite.prepare("PRAGMA table_info(exports)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "card_type")) {
    sqlite.exec("ALTER TABLE exports ADD COLUMN card_type TEXT NOT NULL DEFAULT 'qa'");
  }
  sqlite.exec("DROP INDEX IF EXISTS uq_exports_word_deck");
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_exports_word_deck_type ON exports(user_word_id, deck_id, card_type)",
  );
}

try {
  migrate();
} catch {
  // 迁移失败不应该让整个应用起不来：导出功能会自己报错，其余功能不受影响
}

export const db = drizzle(sqlite, { schema });
export { sqlite, dbPath };

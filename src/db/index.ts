import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { sqlite, dbPath } from "./sqlite";
import { ensureCefrColumns } from "./ensure-cefr";
import { ensureBlockColumns } from "./ensure-blocks";
import { ensureTextMetaColumns } from "./ensure-text-meta";

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
  source_raw TEXT,
  category TEXT,
  read_idx INTEGER,
  read_ratio REAL,
  completed_at INTEGER
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
  dict_entry TEXT,
  via TEXT NOT NULL DEFAULT 'reader',
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
  target TEXT NOT NULL DEFAULT 'markji',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  pushed_at INTEGER
);
-- 唯一索引不写在这里：老库的 exports 还没有 card_type 列，
-- 要先 ALTER 加列再建索引，统一放到下面的 migrate() 里做。

-- settings / users / sessions 由 db/ensure-auth.ts 在连接层创建（需要重建老表）。
-- 这里保留 IF NOT EXISTS 定义只为让本文件仍然是完整的结构快照，重复执行无害。
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL DEFAULT 'local',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
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

  // contexts.dict_entry（P25）：查词当时的词典结果快照，回看时直接用，不再查词典
  const ctxCols = sqlite.prepare("PRAGMA table_info(contexts)").all() as { name: string }[];
  if (!ctxCols.some((c) => c.name === "dict_entry")) {
    sqlite.exec("ALTER TABLE contexts ADD COLUMN dict_entry TEXT");
  }

  // contexts.via（P31）：记录来源 reader / extension。
  // 加列后回填一次：P31 之前只有插件能往「网页摘录」（source_type='web'）里写记录，
  // 那些记录其实都是插件记的。语句可重复执行，只会改原本是 'reader' 的行。
  if (!ctxCols.some((c) => c.name === "via")) {
    sqlite.exec("ALTER TABLE contexts ADD COLUMN via TEXT NOT NULL DEFAULT 'reader'");
  }
  sqlite.exec(
    `UPDATE contexts SET via = 'extension'
      WHERE via = 'reader' AND text_id IN (SELECT id FROM texts WHERE source_type = 'web')`,
  );

  // texts：2026-11 新增的 CEFR 粗估字段（与回填脚本共用定义）
  ensureCefrColumns(sqlite);
  // 结构化导入：texts.source_* + paragraphs.block_*（与离线脚本共用定义）
  ensureBlockColumns(sqlite);
  // 分类 + 阅读进度（P16）
  ensureTextMetaColumns(sqlite);

  const cols = sqlite.prepare("PRAGMA table_info(exports)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "card_type")) {
    sqlite.exec("ALTER TABLE exports ADD COLUMN card_type TEXT NOT NULL DEFAULT 'qa'");
  }
  // exports.target（P27）：导出到哪个卡片应用，老记录都是墨墨
  if (!cols.some((c) => c.name === "target")) {
    sqlite.exec("ALTER TABLE exports ADD COLUMN target TEXT NOT NULL DEFAULT 'markji'");
  }
  sqlite.exec("DROP INDEX IF EXISTS uq_exports_word_deck");
  sqlite.exec("DROP INDEX IF EXISTS uq_exports_word_deck_type");
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_exports_word_target_deck_type ON exports(user_word_id, target, deck_id, card_type)",
  );
}

try {
  migrate();
} catch {
  // 迁移失败不应该让整个应用起不来：导出功能会自己报错，其余功能不受影响
}

export const db = drizzle(sqlite, { schema });
export { sqlite, dbPath };

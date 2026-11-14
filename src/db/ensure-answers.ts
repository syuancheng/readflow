import type Database from "better-sqlite3";
import { addColumnIfMissing } from "./alter";

/**
 * P34：每段回答原文 + 老师笔记的来源。
 * - explain_answers：讲解完整结束后存一行，event_id 就是 answerId（= explain_events.id）；
 *   讲解记录过期删除时随外键一起删除。
 * - learner_profiles.note_update_kind：'nightly'（每晚整理）/ 'user'（用户手改）；老数据为 NULL。
 * 幂等，可重复执行。learner_profiles 必须已经存在（ensure-auth 先建它）。
 */
export function ensureAnswers(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS explain_answers (
      event_id    TEXT PRIMARY KEY REFERENCES explain_events(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      context_id  TEXT,
      ask_label   TEXT,
      answer_text TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_explain_answers_context ON explain_answers(context_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_explain_answers_user ON explain_answers(user_id, created_at);
  `);
  const cols = sqlite.prepare("PRAGMA table_info(learner_profiles)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "note_update_kind")) {
    addColumnIfMissing(
      sqlite,
      "ALTER TABLE learner_profiles ADD COLUMN note_update_kind TEXT",
      "learner_profiles",
      "note_update_kind",
    );
  }
}

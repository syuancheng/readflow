import type Database from "better-sqlite3";
import { addColumnIfMissing } from "./alter";

/**
 * P35 句子音频的两张表（spec §1.1），启动时建，可以重复执行。
 * - tts_audio：语音合成结果，按内容复用，所有用户共用；音频文件放在数据库同目录的 tts/ 下。
 * - markji_media：墨墨的 file.id 属于上传它的墨墨账号，所以按用户记。
 * 另给 push_jobs 加一列 audio_missing：这次推送里有几张卡没配上音频（PRD F3）。
 *
 * P33 时这两张表的列名是 hash / audio_hash（从未写过数据，启动时已删）。万一老结构还在：
 * 空的直接删；有数据就改名保留成 *_p33，不冒丢数据的险。
 */
export function ensureAudioTables(sqlite: Database.Database): void {
  const cols = (table: string) =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  sqlite.transaction(() => {
    for (const [table, oldCol] of [
      ["tts_audio", "hash"],
      ["markji_media", "audio_hash"],
    ] as const) {
      const c = cols(table);
      if (c.length === 0 || !c.includes(oldCol)) continue;
      const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      if (n === 0) {
        sqlite.exec(`DROP TABLE ${table}`);
      } else {
        sqlite.exec(`ALTER TABLE ${table} RENAME TO ${table}_p33`);
        console.warn(`[db] 旧结构的 ${table} 里有 ${n} 行数据，已改名为 ${table}_p33 保留`);
      }
    }

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS tts_audio (
        key TEXT PRIMARY KEY,            -- audioKey(text, voice)，见 src/lib/cards/audio.ts
        text TEXT NOT NULL,
        model TEXT NOT NULL,
        voice TEXT NOT NULL,
        file_path TEXT NOT NULL,         -- 相对数据目录：tts/<key>.wav
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS markji_media (
        user_id TEXT NOT NULL,
        audio_key TEXT NOT NULL,
        file_id TEXT NOT NULL,           -- 墨墨返回的 file.id，大小写敏感，原样保存
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, audio_key)
      );
    `);
  })();

  if (cols("push_jobs").length > 0 && !cols("push_jobs").includes("audio_missing")) {
    addColumnIfMissing(
      sqlite,
      "ALTER TABLE push_jobs ADD COLUMN audio_missing INTEGER NOT NULL DEFAULT 0",
      "push_jobs",
      "audio_missing",
    );
  }
}

/**
 * 回填 user_words.lemma：用修好后的 lookup() 重新算原形，并把重复的词合并。
 *
 * 背景：旧版 lookup() 用「释义长度 > 10」猜词条，glistened 这类词的原形被存成了
 * 自己，词库里 glisten / glistened 会算成两个词、卡片标题也是变形。修好之后，
 * 库里已有的数据需要用这个脚本对齐，否则新老两套规则会混在一起。
 *
 * 默认只打印计划，不动数据；加 --apply 才真正执行。
 *   node .verify/scripts/backfill-lemma.js
 *   node .verify/scripts/backfill-lemma.js --apply
 */
import Database from "better-sqlite3";
import { lookup } from "../src/lib/dict";

const DB = "data/readflow.db";
const apply = process.argv.includes("--apply");

type Row = {
  id: string;
  lemma: string;
  display_form: string;
  translation: string | null;
  phonetic: string | null;
  pos: string | null;
};

const db = new Database(DB);
db.pragma("busy_timeout = 10000");
db.pragma("foreign_keys = ON");

const rows = db
  .prepare(
    "SELECT id, lemma, display_form, translation, phonetic, pos FROM user_words ORDER BY created_at",
  )
  .all() as Row[];

console.log(`共 ${rows.length} 个词，模式：${apply ? "APPLY（会写库）" : "DRY-RUN（只看计划）"}`);

let changed = 0;
let merged = 0;

db.transaction(() => {
  for (const row of rows) {
    const res = lookup(row.display_form);
    const next = res.lemmaForm;
    const nextTranslation = res.entry?.translation ?? null;
    const nextPhonetic = res.entry?.phonetic ?? null;
    const nextPos = res.entry?.pos ?? null;

    const lemmaChanged = next !== row.lemma;
    // 释义也要刷：旧数据存的是「xx的过去式」这种指针式释义，光改 lemma 不够
    const glossChanged = !!nextTranslation && nextTranslation !== row.translation;
    const phoneticChanged = !!nextPhonetic && nextPhonetic !== row.phonetic;

    if (!lemmaChanged && !glossChanged && !phoneticChanged) continue;

    changed++;
    const target = lemmaChanged
      ? (db
          .prepare("SELECT id, lemma FROM user_words WHERE lemma = ?")
          .get(next) as { id: string; lemma: string } | undefined)
      : undefined;

    if (target) {
      merged++;
      console.log(`  合并：${row.display_form}  ${row.lemma} -> ${next}（并入已有词 ${target.lemma}）`);
    } else if (lemmaChanged) {
      console.log(
        `  改原形：${row.display_form}  ${row.lemma} -> ${next}${glossChanged ? "（释义同时更新）" : ""}`,
      );
    } else {
      console.log(`  刷释义：${row.display_form}`);
    }

    if (!apply) continue;

    if (!target) {
      db.prepare(
        `UPDATE user_words SET
           lemma = COALESCE(?, lemma),
           translation = COALESCE(?, translation),
           phonetic = COALESCE(?, phonetic),
           pos = COALESCE(?, pos)
         WHERE id = ?`,
      ).run(next, nextTranslation, nextPhonetic, nextPos, row.id);
      continue;
    }

    // 1) 上下文迁到目标词
    db.prepare("UPDATE contexts SET user_word_id = ? WHERE user_word_id = ?").run(target.id, row.id);

    // 2) 导出记录也要迁，否则删词时 CASCADE 会把「已推送」记录一起删掉。
    //    目标词在同一牌组同一类型已有记录时，旧记录直接丢弃（幂等键唯一）。
    const exportsOfOld = db
      .prepare("SELECT id, deck_id, card_type FROM exports WHERE user_word_id = ?")
      .all(row.id) as { id: string; deck_id: string; card_type: string }[];

    for (const ex of exportsOfOld) {
      const dup = db
        .prepare(
          "SELECT id FROM exports WHERE user_word_id = ? AND deck_id = ? AND card_type = ?",
        )
        .get(target.id, ex.deck_id, ex.card_type);
      if (dup) {
        db.prepare("DELETE FROM exports WHERE id = ?").run(ex.id);
      } else {
        db.prepare("UPDATE exports SET user_word_id = ? WHERE id = ?").run(target.id, ex.id);
      }
    }

    // 3) 删掉多余的那行
    db.prepare("DELETE FROM user_words WHERE id = ?").run(row.id);
  }
})();

console.log(`\n计划改动 ${changed} 个，其中合并 ${merged} 个。${apply ? "已写入。" : "未写入，加 --apply 执行。"}`);
db.close();

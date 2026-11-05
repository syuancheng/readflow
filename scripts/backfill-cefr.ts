/**
 * 回填已有文本的 CEFR 粗估。
 *
 * 新导入的文章在 POST /api/texts 里就会算；这个脚本是给「改算法之前导入的」
 * 老文本补数据用的。默认 DRY-RUN，只打印结果不动库。
 *
 *   node .verify/scripts/backfill-cefr.js                 # 只看结果
 *   node .verify/scripts/backfill-cefr.js --apply        # 写入缺失的行
 *   node .verify/scripts/backfill-cefr.js --apply --force # 用当前算法重算全部（跳过手改过的）
 *
 * 必须从项目根目录运行：cefr-dict.ts 用 process.cwd() 定位 ECDICT。
 */
import Database from "better-sqlite3";
import { ensureCefrColumns } from "../src/db/ensure-cefr";
import { estimateCefrForParts } from "../src/lib/cefr-dict";

const DB = "data/readflow.db";
const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");

type TextRow = {
  id: string;
  title: string;
  word_count: number;
  cefr_level: string | null;
  cefr_overridden: number;
};

const db = new Database(DB);
db.pragma("busy_timeout = 10000");
// 与服务启动时的 migrate() 共用同一份列定义；服务还没重启过也能独立跑
ensureCefrColumns(db);

const rows = db
  .prepare("SELECT id, title, word_count, cefr_level, cefr_overridden FROM texts ORDER BY created_at")
  .all() as TextRow[];

console.log(`共 ${rows.length} 篇文本，模式：${apply ? "APPLY（会写库）" : "DRY-RUN（只看结果）"}${force ? " + FORCE（重算）" : ""}`);

let written = 0;
let skipped = 0;
let failed = 0;

for (const row of rows) {
  if (row.cefr_overridden) {
    console.log(`  跳过（已手动改级）：${row.title}`);
    skipped++;
    continue;
  }
  if (row.cefr_level && !force) {
    console.log(`  跳过（已有 ${row.cefr_level}）：${row.title}`);
    skipped++;
    continue;
  }

  const parts = (
    db.prepare("SELECT content FROM paragraphs WHERE text_id = ? ORDER BY idx").all(row.id) as {
      content: string;
    }[]
  ).map((p) => p.content);

  const r = estimateCefrForParts(parts);
  if (!r) {
    console.log(`  估不出来（词典缺失 / 非英文 / 太短）：${row.title}`);
    failed++;
    continue;
  }

  const v = r.detail.vocabulary;
  const c = r.detail.complexity;
  console.log(
    `  ${r.level}  ${String(r.score).padStart(5)} 分  置信度 ${r.confidence}` +
      `${r.adjacentLevel ? `（接近 ${r.adjacentLevel}）` : ""}  ${row.title}`,
  );
  console.log(
    `      词 ${r.detail.wordCount} / 句 ${r.detail.sentenceCount} · ` +
      `高频 ${(v.bandRatios.core * 100).toFixed(1)}% · 中频 ${(v.bandRatios.mid * 100).toFixed(1)}% · ` +
      `低频/未收录 ${(v.bandRatios.advanced * 100).toFixed(1)}% · ` +
      `平均句长 ${c.avgSentenceLength} 词 · 超长句 ${(c.longSentenceRatio * 100).toFixed(0)}%`,
  );

  if (apply) {
    db.prepare(
      `UPDATE texts SET cefr_level = ?, cefr_score = ?, cefr_detail = ?, cefr_method = ?
       WHERE id = ?`,
    ).run(r.level, r.score, JSON.stringify(r.detail), r.method, row.id);
  }
  written++;
}

console.log(
  `\n${apply ? "写入" : "计划写入"} ${written} 篇，跳过 ${skipped} 篇，估不出来 ${failed} 篇。` +
    (apply ? "" : " 加 --apply 执行。"),
);
db.close();

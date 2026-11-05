/**
 * 一次性迁移：修复老版 buildAnchor（固定 ±40 字符窗口）造成的截断锚点。
 *
 * contexts.prefix / suffix 之前是从词的位置前后各剁 40 个字符，
 * 会把 thus 剁成 hus、让孤立的句号单独当后文。本脚本从 paragraphs.content
 * 原文重定位 quote，按句子边界（句号/问号/叹号/省略号）重算前后文。
 *
 * 运行：node scripts/migrate-anchors.mjs （幂等，可重复执行）
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "readflow.db");
if (!fs.existsSync(dbPath)) {
  console.error(`DB 不存在: ${dbPath}`);
  process.exit(1);
}
const db = new Database(dbPath);
db.pragma("busy_timeout = 10000");

/** 与 src/lib/sentence.ts splitSentences 相同的句子切分 */
function splitSentences(text) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    return [...seg.segment(text)].map((s) => ({
      start: s.index,
      end: s.index + s.segment.length,
    }));
  }
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/[^\n]+/g)) {
    const lineStart = m.index;
    let s = lineStart;
    for (const sm of m[0].matchAll(/[^.!?…]*[.!?…]+["')\]]*\s*/g)) {
      const segStart = lineStart + sm.index;
      if (segStart + sm[0].length > s) {
        out.push({ start: s, end: segStart + sm[0].length });
        s = segStart + sm[0].length;
      }
    }
    if (s < lineStart + m[0].length) out.push({ start: s, end: lineStart + m[0].length });
    last = lineStart + m[0].length;
  }
  return out.length ? out : [{ start: 0, end: text.length }];
}

const rows = db
  .prepare(
    `SELECT c.id, c.quote, c.start, c.end, p.content AS para
       FROM contexts c JOIN paragraphs p ON p.id = c.paragraph_id`,
  )
  .all();

const update = db.prepare("UPDATE contexts SET prefix = ?, suffix = ? WHERE id = ?");
let fixed = 0;
let skipped = 0;

for (const r of rows) {
  const para = r.para ?? "";
  let s = r.start;
  let e = r.end;
  // offset 快路径失效（文本变过）时按 quote 定位：唯一命中才认
  if (para.slice(s, e) !== r.quote) {
    const first = para.indexOf(r.quote);
    if (first < 0 || para.indexOf(r.quote, first + 1) !== -1) {
      skipped++;
      continue;
    }
    s = first;
    e = first + r.quote.length;
  }

  const sentences = splitSentences(para);
  let s0 = -1;
  let s1 = -1;
  sentences.forEach((sn, i) => {
    if (sn.end > s && sn.start < e) {
      if (s0 < 0) s0 = i;
      s1 = i;
    }
  });
  if (s0 < 0) {
    skipped++;
    continue;
  }
  const prefix = para.slice(sentences[s0].start, s);
  const suffix = para.slice(e, sentences[s1].end);

  if (prefix !== r.prefix || suffix !== r.suffix) {
    update.run(prefix, suffix, r.id);
    fixed++;
  }
}

console.log(`contexts 共 ${rows.length} 条：修复 ${fixed}，无法定位跳过 ${skipped}，其余本就正确`);
db.close();

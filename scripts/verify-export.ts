/**
 * 临时验证脚本：不启动 dev server，直接把「收词 → 生成卡片」这条链路跑一遍。
 *
 * 目的：在真正往墨墨写卡之前，确认三种卡片模板产出的语法是合法的
 * （Markji 语法写错不报错，只会静默渲染成乱码，所以必须离线检查）。
 *
 * 用法：node --experimental-strip-types scripts/verify-export.ts
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { tokenize, resolveAnchor } from "../src/lib/tokenize";
import { sentenceAround } from "../src/lib/split";
import { buildCard, lintCard, CARD_TYPES } from "../src/lib/cardgen";
import { distractors, lookup } from "../src/lib/dict";

const ROOT = process.cwd();
const db = new Database(path.join(ROOT, "data", "lexreader.db"));
db.pragma("foreign_keys = ON");

const OUT = "/tmp/cards";
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f));

type Row = { id: string; title: string };

const text = db.prepare("select id, title from texts order by created_at desc limit 1").get() as
  | Row
  | undefined;
if (!text) {
  console.error("数据库里没有文本，先在页面上导入一篇再来");
  process.exit(1);
}

const paras = db
  .prepare("select id, idx, content from paragraphs where text_id = ? order by idx limit 6")
  .all(text.id) as { id: string; idx: number; content: string }[];

// 从段落里挑几个「词典里有实质释义」的实词当测试样本
const banned = new Set([
  "the", "and", "that", "this", "with", "from", "have", "were", "they", "there",
  "which", "whom", "whose", "been", "will", "would", "could", "should", "about",
]);
const picked: { word: string; para: typeof paras[number]; start: number; end: number }[] = [];

for (const p of paras) {
  for (const t of tokenize(p.content)) {
    if (!t.word) continue;
    const w = t.text.toLowerCase();
    if (w.length < 4 || banned.has(w)) continue;
    if (picked.some((x) => x.word.toLowerCase() === w)) continue;

    const r = lookup(w);
    if (!r.entry?.translation || r.entry.translation.length < 12) continue;

    picked.push({ word: t.text, para: p, start: t.start, end: t.end });
    if (picked.length >= 3) break;
  }
  if (picked.length >= 3) break;
}

if (picked.length === 0) {
  console.error("这段话里找不到合适的测试词");
  process.exit(1);
}

console.log(`文本：《${text.title}》，取 ${picked.length} 个词做样本\n`);

const now = Date.now();
const createdWordIds: string[] = [];

let okCount = 0;
let badCount = 0;

for (const item of picked) {
  const r = lookup(item.word);

  // 1. 模拟收词（与 POST /api/words 相同的写入形状）
  const wordId = `verify-${item.word.toLowerCase()}-${now}`;
  createdWordIds.push(wordId);

  const before = item.para.content.slice(Math.max(0, item.start - 40), item.start);
  const suffix = item.para.content.slice(item.end, item.end + 40);

  db.prepare(
    `insert into user_words (id, user_id, lemma, display_form, pos, phonetic, translation, note, created_at)
     values (?, 'local', ?, ?, ?, ?, ?, null, ?)`,
  ).run(
    wordId,
    r.lemmaForm,
    item.word,
    r.entry?.pos ?? null,
    r.entry?.phonetic ?? null,
    r.entry?.translation ?? "(待补充释义)",
    now,
  );

  db.prepare(
    `insert into contexts (id, user_word_id, text_id, paragraph_id, start, "end", quote, prefix, suffix, ai_gloss, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
  ).run(
    `verify-ctx-${wordId}`,
    wordId,
    text.id,
    item.para.id,
    item.start,
    item.end,
    item.word,
    before,
    suffix,
    now,
  );

  // 2. 模拟导出流程：回原文定位 → 截整句 → 生成卡片
  const hit = resolveAnchor(item.para.content, {
    start: item.start,
    end: item.end,
    quote: item.word,
    prefix: before,
    suffix,
  });

  if (!hit) {
    console.log(`✗ ${item.word}: 锚点定位失败`);
    badCount++;
    continue;
  }

  const { sentence, offset } = sentenceAround(item.para.content, hit.start, hit.end);

  console.log(`── ${item.word}  (lemma: ${r.lemmaForm})  第 ${item.para.idx + 1} 段`);
  console.log(`   句子：${sentence}`);

  for (const t of CARD_TYPES) {
    const content = buildCard(t.key, {
      word: item.para.content.slice(hit.start, hit.end),
      lemma: r.lemmaForm,
      phonetic: r.entry?.phonetic ?? null,
      translation: r.entry?.translation ?? "",
      sentence,
      offset,
      sourceTitle: text.title,
      distractors:
        t.key === "choice"
          ? distractors({
              translation: r.entry?.translation ?? null,
              word: item.word,
              lemma: r.lemmaForm,
            })
          : undefined,
    });

    const lint = lintCard(content);
    const file = path.join(OUT, `${item.word.toLowerCase()}-${t.key}.txt`);
    fs.writeFileSync(file, content, "utf8");

    if (lint.ok) {
      okCount++;
      console.log(`   ✓ ${t.key.padEnd(6)} 语法自检通过 → ${file}`);
    } else {
      badCount++;
      console.log(`   ✗ ${t.key.padEnd(6)} ${lint.problems.join("；")}`);
    }
  }
  console.log();

  // 3. 清理测试数据
  db.prepare("delete from contexts where id = ?").run(`verify-ctx-${wordId}`);
  db.prepare("delete from user_words where id = ?").run(wordId);
}

console.log(`结果：${okCount} 张通过，${badCount} 张有问题`);
console.log(`卡片文件在 ${OUT}，可以再交给 markji.py lint 复核`);

const sample = path.join(OUT, `${picked[0].word.toLowerCase()}-qa.txt`);
if (fs.existsSync(sample)) {
  console.log("\n=== 样例：看词猜义 ===\n");
  console.log(fs.readFileSync(sample, "utf8"));
}

db.close();

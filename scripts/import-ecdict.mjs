/**
 * 把 ECDICT CSV 导入到独立 SQLite 数据库 data/dict/ecdict.db
 *
 * 表结构只保留查询需要的字段，丢弃 detail/audio 等大字段。
 * exchange 字段是词形还原的关键：went -> "0:go/1:p" -> 原形 go
 *
 * 用法：node scripts/import-ecdict.mjs
 */

import Database from "better-sqlite3";
import { createReadStream } from "node:fs";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(__dirname, "..", "data", "dict", "ecdict.csv");
const DB_PATH = join(__dirname, "..", "data", "dict", "ecdict.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = OFF"); // 导入期间不关心持久性
db.pragma("cache_size = -64000"); // 64MB cache

db.exec(`
  CREATE TABLE IF NOT EXISTS ecdict (
    word      TEXT PRIMARY KEY,
    phonetic  TEXT,
    definition TEXT,
    translation TEXT,
    pos       TEXT,
    collins   INTEGER,
    oxford     INTEGER,
    tag       TEXT,
    bnc       INTEGER,
    frq        INTEGER,
    exchange  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ecdict_exchange ON ecdict(exchange);
`);

// CSV 解析：处理引号包裹的字段
function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  let current = "";
  let inQuotes = false;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      current += ch;
      i++;
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === ",") {
        fields.push(current);
        current = "";
        i++;
        continue;
      }
      current += ch;
      i++;
    }
  }
  fields.push(current);
  return fields;
}

const stmt = db.prepare(`
  INSERT OR REPLACE INTO ecdict
    (word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMany = db.transaction((rows) => {
  for (const r of rows) stmt.run(...r);
});

const rl = readline.createInterface({
  input: createReadStream(CSV_PATH, { encoding: "utf-8" }),
  crlfDelay: Infinity,
});

let header = null;
let batch = [];
let count = 0;
const start = Date.now();

rl.on("line", (line) => {
  if (!header) {
    header = line.split(",");
    return;
  }
  const fields = parseCSVLine(line);
  if (fields.length < 12) return;

  const word = fields[0];
  if (!word) return;

  batch.push([
    word,
    fields[1] || null,     // phonetic
    fields[2] || null,     // definition
    fields[3] || null,     // translation
    fields[4] || null,     // pos
    fields[5] ? parseInt(fields[5]) : null,  // collins
    fields[6] ? parseInt(fields[6]) : null,  // oxford
    fields[7] || null,     // tag
    fields[8] ? parseInt(fields[8]) : null,  // bnc
    fields[9] ? parseInt(fields[9]) : null,  // frq
    fields[10] || null,    // exchange
  ]);

  if (batch.length >= 5000) {
    insertMany(batch);
    count += batch.length;
    batch = [];
    if (count % 50000 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`${count.toLocaleString()} rows (${elapsed}s)`);
    }
  }
});

rl.on("close", () => {
  if (batch.length > 0) {
    insertMany(batch);
    count += batch.length;
  }
  db.pragma("synchronous = NORMAL");
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done: ${count.toLocaleString()} rows in ${elapsed}s`);

  // 验证
  const test = db.prepare("SELECT word, phonetic, translation, exchange FROM ecdict WHERE word = ?").get("went");
  console.log("Verify went:", JSON.stringify(test));
  const test2 = db.prepare("SELECT word, phonetic, translation FROM ecdict WHERE word = ?").get("go");
  console.log("Verify go:", JSON.stringify(test2));

  db.close();
});

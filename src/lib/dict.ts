import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let dictDb: Database.Database | null = null;

function getDictDb(): Database.Database {
  if (dictDb) return dictDb;

  const dbPath = path.join(process.cwd(), "data", "dict", "ecdict.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`ECDICT database not found at ${dbPath}. Run: node scripts/import-ecdict.mjs`);
  }

  dictDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  dictDb.pragma("query_only = ON");
  return dictDb;
}

/**
 * exchange 字段格式：`0:原形/1:变形类型/2:变形类型...`
 * 变形类型：p=过去式, d=过去分词, i=现在分词, 3=第三人称单数, r=比较级, t=最高级
 * s=名词复数, 1=第一人称单数, 2=第二人称单数
 *
 * 例：went -> "0:go/1:p"，原形是 go，变形是 past tense
 */
export function lemma(word: string): string {
  const db = getDictDb();
  const row = db
    .prepare("SELECT exchange FROM ecdict WHERE word = ? COLLATE NOCASE")
    .get(word) as { exchange: string | null } | undefined;

  if (!row?.exchange) return word;

  // 0:go/1:p -> 取 "0:" 后面的部分直到 "/"
  const match = row.exchange.match(/^0:([^/]+)/);
  return match ? match[1] : word;
}

export type DictEntry = {
  word: string;
  phonetic: string | null;
  definition: string | null;
  translation: string | null;
  pos: string | null;
  collins: number | null;
  oxford: number | null;
  tag: string | null;
  frq: number | null;
};

/**
 * 取若干个「同词性、长度相近、且常用」的干扰项，供选择题卡片使用。
 *
 * 两个坑：
 *   1. ECDICT 的 `pos` 列基本都是空的，词性其实写在释义开头（"n. 银行…"），
 *      所以按释义前缀过滤。直接查不到词性时，退一步用原形的词性。
 *   2. 不能纯随机 —— 77 万词条里随机抽会抽到 piasters / batisse 这种，
 *      选项一眼假，题目就废了。用 frq（COCA 词频排名）卡住常用词。
 */
export function distractors(opts: {
  translation: string | null;
  word: string;
  lemma?: string;
  count?: number;
}): string[] {
  const db = getDictDb();
  const { word, lemma, count = 3 } = opts;

  let posTag = derivePos(opts.translation);

  // 直接查不到词性（如 "下雨（rain的过去式）"）就用原形的释义推
  if (!posTag && lemma && lemma.toLowerCase() !== word.toLowerCase()) {
    const row = db
      .prepare("SELECT translation FROM ecdict WHERE word = ? COLLATE NOCASE")
      .get(lemma) as { translation: string | null } | undefined;
    posTag = derivePos(row?.translation ?? null);
  }

  const len = word.length;
  const lo = Math.max(3, len - 2);
  const hi = len + 2;

  // 常用词优先：frq 是 COCA 排名，数字越小越常用。抽 120 个再挑。
  const posClause = posTag ? "AND translation LIKE ?" : "";
  const params: unknown[] = [lo, hi, 30000];
  if (posTag) params.push(`${posTag}. %`);

  const rows = db
    .prepare(
      `SELECT word FROM ecdict
       WHERE length(word) BETWEEN ? AND ?
         AND frq > 0 AND frq < ?
         AND word GLOB '[a-z]*'
         AND word NOT LIKE '% %'
         AND translation IS NOT NULL
         ${posClause}
       ORDER BY random() LIMIT 120`,
    )
    .all(...params) as { word: string }[];

  const banned = new Set([word.toLowerCase(), (lemma ?? "").toLowerCase()]);
  const out: string[] = [];
  for (const r of rows) {
    const w = r.word.toLowerCase();
    if (banned.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= count) break;
  }

  // 同词性常用词不够（生僻词/短语）时放宽词频，但仍然是常用词
  if (out.length < count) {
    const fallback = db
      .prepare(
        `SELECT word FROM ecdict
         WHERE length(word) BETWEEN ? AND ?
           AND frq > 0 AND frq < 30000
           AND word GLOB '[a-z]*'
           AND word NOT LIKE '% %'
         ORDER BY random() LIMIT 120`,
      )
      .all(lo, hi) as { word: string }[];

    for (const r of fallback) {
      const w = r.word.toLowerCase();
      if (banned.has(w) || out.includes(w)) continue;
      out.push(w);
      if (out.length >= count) break;
    }
  }

  return out;
}

/** 从中文释义里抠出词性标记：`n. 银行` → `n`；`vt. 放弃` → `vt` */
export function derivePos(translation: string | null | undefined): string | null {
  if (!translation) return null;
  const m = translation.trim().match(/^([a-z]{1,5})\./i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 查词典。先直接查词，查不到就做词形还原再查。
 *
 * 例如查 "went" -> 先查 went（有结果，但 translation 是 "go的过去式"）
 * -> 同时用 exchange 还原到 go，再查 go，返回完整释义。
 */
export function lookup(word: string): { entry: DictEntry | null; originalForm: string; lemmaForm: string } {
  const db = getDictDb();

  // 1. 直接查
  const direct = db
    .prepare("SELECT word, phonetic, definition, translation, pos, collins, oxford, tag, frq FROM ecdict WHERE word = ? COLLATE NOCASE")
    .get(word) as DictEntry | undefined;

  if (direct && direct.translation && direct.translation.length > 10) {
    // 直接查到了，且有实质释义（不是 "go的过去式" 这种简短的）
    return { entry: direct, originalForm: word, lemmaForm: direct.word };
  }

  // 2. 词形还原
  const lemmaForm = lemma(word);
  if (lemmaForm !== word) {
    const lemmaEntry = db
      .prepare("SELECT word, phonetic, definition, translation, pos, collins, oxford, tag, frq FROM ecdict WHERE word = ? COLLATE NOCASE")
      .get(lemmaForm) as DictEntry | undefined;

    if (lemmaEntry && lemmaEntry.translation) {
      // 合并：用原形的完整释义，但标注原词形态
      return {
        entry: {
          ...lemmaEntry,
          word: `${lemmaEntry.word} (${word})`, // 标注：go (went)
        },
        originalForm: word,
        lemmaForm: lemmaEntry.word,
      };
    }
  }

  // 3. 如果直接查到了但释义太短（如 "go的过去式"），也返回
  if (direct) {
    return { entry: direct, originalForm: word, lemmaForm: direct.word };
  }

  return { entry: null, originalForm: word, lemmaForm: lemmaForm };
}

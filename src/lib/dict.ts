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
 * exchange 字段格式：`键:值/键:值...`，键 0 表示「原形」，其余是变形类型：
 * p=过去式, d=过去分词, i=现在分词, 3=第三人称单数, r=比较级, t=最高级,
 * s=名词复数, 1=第一人称单数, 2=第二人称单数
 *
 * 两个必须绕开的坑（实测 ECDICT 数据）：
 *   1. `0:` **不一定在第一位**。went 是 `0:go/1:p`，但 glistened 是 `1:pd/0:glisten`、
 *      glasses 是 `1:s3/0:glass`。所以不能用 `^0:` 锚定开头。
 *   2. 有些变形词的 exchange 是**空的**，只在中文释义里留了指针：`was` 的释义是
 *      "be的过去式"，exchange 为 null。这时只能解析中文。
 */
export function lemma(word: string): string {
  const db = getDictDb();
  const row = db
    .prepare("SELECT exchange, translation FROM ecdict WHERE word = ? COLLATE NOCASE")
    .get(word) as { exchange: string | null; translation: string | null } | undefined;

  if (!row) return word;

  // 形状 1：exchange 里的 0:xxx（允许出现在任意位置）
  const fromExchange = row.exchange?.match(/(?:^|\/)0:([^/]+)/)?.[1];
  if (fromExchange) return fromExchange;

  // 形状 2：中文指针「be的过去式」「study的复数」。必须锚在开头，
  // 否则 "下雨（rain的过去式）" 这种括号里的补充说明会被误当成原形来源。
  const pointer = row.translation?.match(
    /^\s*([A-Za-z][A-Za-z'’-]*)\s*的(?:过去式|过去分词|现在分词|复数|复数形式|比较级|最高级|第三人称单数)/,
  );
  if (pointer) return pointer[1];

  return word;
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

const SELECT_ENTRY =
  "SELECT word, phonetic, definition, translation, pos, collins, oxford, tag, frq FROM ecdict WHERE word = ? COLLATE NOCASE";

function cjkChars(s: string | null | undefined): Set<string> {
  return new Set(s?.match(/[\u4e00-\u9fff]/g) ?? []);
}

/** 两条释义的汉字重合数，用来粗略判断它们是不是同一个意思 */
function cjkOverlap(a: string | null | undefined, b: string | null | undefined): number {
  const setB = cjkChars(b);
  let n = 0;
  for (const c of cjkChars(a)) if (setB.has(c)) n++;
  return n;
}

/** 释义本身就是个指针：「go的过去式」「be的过去分词」 */
function isPointerGloss(translation: string | null | undefined): boolean {
  const t = translation?.trim() ?? "";
  return /^[A-Za-z][A-Za-z'’-]*\s*的/.test(t) || t.length <= 6;
}

/**
 * 查词典：先定原形，再决定展示哪条释义。
 *
 * 旧实现用「释义长度 > 10」猜测有没有实质释义，结果 glistened 的
 * "v. 湿物闪耀, 闪亮( glisten的过去式和过去分词 )" 被当成独立词条，
 * lemma 也就存成了 glistened —— 词库里 glisten / glistened 会变成两个词。
 *
 * 现在的规则：
 *   1. 原形一律由 exchange 或中文指针算出，不再猜。
 *   2. 变形词展示哪条释义，看它自己是不是「独立词条」：
 *      - 有柯林斯星级 / 牛津核心词 / 词频 → 用自己的，例如 glasses（眼镜）、
 *        better（较好的）、running（赛跑），这些义项丢了很亏；
 *      - 释义是「xx的过去式」这种指针 → 用原形的，例如 went；
 *      - 释义和原形释义**没有语义重叠** → 用自己的，例如 leaves（树叶，
 *        它的 exchange 却指向 leave「离开」，直接用原形会把阅读时的意思讲错）；
 *      - 其余情况（glistened→glisten、studies→study）→ 用原形的。
 *   3. lemmaForm 一律小写，它是词库去重键；句首大写的 "The" 不该和 "the" 分成两个词。
 */
export function lookup(word: string): { entry: DictEntry | null; originalForm: string; lemmaForm: string } {
  const db = getDictDb();
  const originalForm = word;
  const direct = db.prepare(SELECT_ENTRY).get(word) as DictEntry | undefined;

  const lemmaForm = lemma(word).toLowerCase();
  const isVariant = lemmaForm !== word.toLowerCase();

  if (isVariant) {
    const lemmaEntry = db.prepare(SELECT_ENTRY).get(lemmaForm) as DictEntry | undefined;

    if (lemmaEntry?.translation) {
      const own = direct?.translation ?? "";
      const ownIsHeadword =
        !!own &&
        (Boolean(direct!.collins) ||
          Boolean(direct!.oxford) ||
          (direct!.frq ?? 0) > 0 ||
          (!isPointerGloss(own) && cjkOverlap(own, lemmaEntry.translation) < 2));

      const entry = ownIsHeadword ? direct! : lemmaEntry;

      return {
        // 标注来源：go (went)。ownIsHeadword 时保留点击的形态，因为它自己就是词条
        entry: { ...entry, word: ownIsHeadword ? word : `${lemmaEntry.word} (${word})` },
        originalForm,
        lemmaForm: lemmaEntry.word.toLowerCase(),
      };
    }
  }

  if (direct) {
    return { entry: direct, originalForm, lemmaForm };
  }

  return { entry: null, originalForm, lemmaForm };
}

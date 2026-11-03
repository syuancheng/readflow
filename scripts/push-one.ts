/**
 * 端到端联调脚本：把词库里的词真的写进墨墨牌组，或修正已经写进去的卡片。
 *
 * 这个脚本存在的唯一原因：dev server 在某些受限环境里起不来（Next 启动时要删
 * .next/dev/cache 下的 .del 文件），而「能不能写进墨墨」这件事只能用真实请求验证。
 * 它复用了和 /api/export 完全相同的库函数（buildCard / lintCard / createCard），
 * 只是把路由里的取数逻辑写得更短，方便单独跑。
 *
 * 用法：
 *   node .verify/scripts/push-one.js list
 *   node .verify/scripts/push-one.js push <词> <qa|cloze|choice> <deckId> <chapterId> [--dry] [--force]
 *   node .verify/scripts/push-one.js retouch <词> <qa|cloze|choice> <deckId> [--dry]
 *
 * retouch 用来自动修正「已经推上去但内容不对」的卡：从 exports 里查回 card_id，
 * 按当前词典数据重新生成全文，再走更新接口**全量替换**。墨墨删不掉卡片，
 * 所以内容写错了这个命令比「删了重推」更实用。
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { resolveAnchor } from "../src/lib/tokenize";
import { sentenceAround } from "../src/lib/split";
import { buildCard, lintCard, type CardType } from "../src/lib/cardgen";
import { createCard, getCard, listChapters, listDecks, markjiToken, updateCard } from "../src/lib/markji";
import { distractors } from "../src/lib/dict";
import { normalizeTranslation } from "../src/lib/text";

const DB = "data/readflow.db";

function openDb() {
  const db = new Database(DB);
  db.pragma("busy_timeout = 10000");
  return db;
}

async function cmdList() {
  if (!markjiToken()) throw new Error("没有 MARKJI_TOKEN");
  const decks = await listDecks();
  console.log(`共 ${decks.length} 个牌组`);
  for (const d of decks) {
    console.log(`\n${d.id}  ${d.name}  (chapters=${d.chapter_count ?? "?"}, cards=${d.card_count ?? "?"})`);
    if ((d.chapter_count ?? 0) > 0) {
      const chapters = await listChapters(d.id);
      for (const c of chapters) {
        console.log(`   └─ ${c.id}  ${c.name}  (${(c.card_ids ?? []).length} 张)`);
      }
    } else {
      console.log("   └─ （没有章节，无法写卡）");
    }
  }
}

function loadWord(db: Database.Database, key: string) {
  const row = db
    .prepare(
      `SELECT w.id, w.display_form, w.lemma, w.phonetic, w.translation,
              c.paragraph_id, c.start, c.end, c.quote, c.prefix, c.suffix,
              p.content AS para, t.title AS source_title
         FROM user_words w
         JOIN contexts c ON c.user_word_id = w.id
         JOIN paragraphs p ON p.id = c.paragraph_id
         JOIN texts t ON t.id = c.text_id
        WHERE w.id = ? OR w.display_form = ? OR w.lemma = ?
        ORDER BY c.created_at DESC
        LIMIT 1`,
    )
    .get(key, key, key) as Record<string, any> | undefined;
  if (!row) throw new Error(`词库里没有找到「${key}」或有上下文的记录`);
  return row;
}

/** 按当前词典数据生成卡片全文（push 和 retouch 共用） */
function renderCard(db: Database.Database, key: string, type: CardType) {
  const row = loadWord(db, key);

  const hit = resolveAnchor(row.para, {
    start: row.start,
    end: row.end,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
  });
  if (!hit) throw new Error("锚点定位失败：原文里找不到这个词");

  const { sentence, offset } = sentenceAround(row.para, hit.start, hit.end);
  const displayWord = row.para.slice(hit.start, hit.end);

  const content = buildCard(type, {
    word: displayWord,
    lemma: row.lemma,
    phonetic: row.phonetic,
    translation: normalizeTranslation(row.translation),
    sentence,
    offset,
    sourceTitle: row.source_title,
    distractors:
      type === "choice"
        ? distractors({ translation: row.translation, word: row.display_form, lemma: row.lemma })
        : undefined,
  });

  const lint = lintCard(content);
  console.log("=== 词 ===", displayWord, "| lemma:", row.lemma, "| type:", type);
  console.log("=== 卡片全文 ===");
  console.log(content);
  console.log("=== 语法自检 ===", lint.ok ? "通过" : `失败：${lint.problems.join("；")}`);
  if (!lint.ok) throw new Error("卡片语法自检没有通过，拒绝写入");

  return { row, content };
}

async function cmdPush(
  key: string,
  type: CardType,
  deckId: string,
  chapterId: string,
  dry: boolean,
) {
  if (!markjiToken()) throw new Error("没有 MARKJI_TOKEN，先配置 .env");
  const db = openDb();
  const { row, content } = renderCard(db, key, type);

  // 幂等闸门：墨墨删不掉卡片，重复推送就是往牌组里堆垃圾。
  // 和 /api/export 用同一个唯一键，所以这里能拦住脚本层面的误跑。
  const already = db
    .prepare(
      `SELECT card_id FROM exports
        WHERE user_word_id = ? AND deck_id = ? AND card_type = ? AND status = 'done'`,
    )
    .get(row.id, deckId, type) as { card_id: string } | undefined;
  if (already && !process.argv.includes("--force")) {
    throw new Error(
      `这个词的 ${type} 卡已经推送过（card_id=${already.card_id}），跳过。` +
        `要改内容用 retouch，确实要再写一张加 --force。`,
    );
  }

  if (dry) {
    console.log("\n[dry] 未写入墨墨");
    return;
  }

  const card = await createCard(deckId, chapterId, content);
  console.log("\n=== 已写入 === card.id =", card.id);

  db.prepare(
    `INSERT INTO exports (id, user_word_id, deck_id, chapter_id, card_id, card_type, status, error, pushed_at)
     VALUES (?,?,?,?,?,?, 'done', NULL, ?)
     ON CONFLICT(user_word_id, deck_id, card_type) DO UPDATE SET
       chapter_id = excluded.chapter_id,
       card_id = excluded.card_id,
       status = 'done', error = NULL, pushed_at = excluded.pushed_at`,
  ).run(randomUUID(), row.id, deckId, chapterId, card.id, type, Date.now());

  console.log("=== exports 表已记录（幂等键 word+deck+type）===");
  db.close();
}

async function cmdRetouch(key: string, type: CardType, deckId: string, dry: boolean) {
  if (!markjiToken()) throw new Error("没有 MARKJI_TOKEN，先配置 .env");
  const db = openDb();
  const { row, content } = renderCard(db, key, type);

  const record = db
    .prepare(
      `SELECT card_id FROM exports
        WHERE user_word_id = ? AND deck_id = ? AND card_type = ? AND status = 'done'`,
    )
    .get(row.id, deckId, type) as { card_id: string } | undefined;
  if (!record?.card_id) throw new Error("没有找到已推送的卡片记录，先跑 push");

  const before = await getCard(deckId, record.card_id);
  if (before.content === content) {
    console.log("\n卡片内容与重新生成的一致，无需更新。");
    db.close();
    return;
  }

  console.log("\n=== 原内容 ===");
  console.log(before.content);

  if (dry) {
    console.log("\n[dry] 未更新墨墨");
    db.close();
    return;
  }

  const after = await updateCard(deckId, record.card_id, content);
  console.log("\n=== 已更新 === card.id =", after.id);
  db.close();
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const positional = rest.filter((a) => !a.startsWith("--"));

  if (mode === "list") return cmdList();

  if (mode === "push") {
    const [key, type, deckId, chapterId] = positional;
    if (!key || !type || !deckId || !chapterId) {
      throw new Error("用法：push <词> <qa|cloze|choice> <deckId> <chapterId> [--dry] [--force]");
    }
    return cmdPush(key, type as CardType, deckId, chapterId, rest.includes("--dry"));
  }

  if (mode === "retouch") {
    const [key, type, deckId] = positional;
    if (!key || !type || !deckId) {
      throw new Error("用法：retouch <词> <qa|cloze|choice> <deckId> [--dry]");
    }
    return cmdRetouch(key, type as CardType, deckId, rest.includes("--dry"));
  }

  throw new Error("用法：list | push ... | retouch ...");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});

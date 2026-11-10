import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { contexts, paragraphs, texts, userWords } from "@/db/schema";
import { lookup } from "@/lib/dict";
import { cardGloss } from "@/lib/gloss";

/**
 * 收词 / 批注写回的唯一落库入口（服务端）。
 *
 * 为什么要收口到这里：AI 释义是流式生成、几秒后才结束，客户端那一刻可能
 * 根本没有 contextId（自动收词关了、词在别的文章里收过、两次请求竞态……）。
 * 早期实现让客户端自己找 context、找不到就 return，于是答案「看得见、存不下」。
 * 现在客户端只把「锚点 + 释义全文」交给服务端，由服务端按锚点决定更新还是补建，
 * 保证「只要 AI 出过答案，就一定能翻回去看到」。
 */
export type WordAnchor = {
  /** 用户选中的原文，用于查词典 / 词形还原 */
  word: string;
  textId: string;
  paragraphId: string;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
};

export type SaveResult = {
  ok: true;
  wordId: string;
  contextId: string;
  lemma: string;
  displayForm: string;
  translation: string;
  phonetic: string | null;
  pos: string | null;
  status: string;
  starred: number;
  isPhrase: boolean;
  /** 本次是否新建了词条（已存在的词再收一次只是补一条 context） */
  created: boolean;
  /** 本次是否新建了 context（false = 命中已有锚点，只更新释义） */
  contextCreated: boolean;
};

export class InvalidAnchorError extends Error {}

/**
 * 校验锚点指向的文章 / 段落确实存在，且文章属于当前账号。
 * 不校验归属的话，B 能把批注（含 AI 释义）挂到 A 的文章上，
 * A 的「已存批注」会混进别人的内容。用「不存在」而非「无权」：不暴露别人的文章。
 */
export function assertAnchor(input: WordAnchor, userId: string): void {
  const text = db.select().from(texts).where(eq(texts.id, input.textId)).get();
  if (!text || text.userId !== userId) throw new InvalidAnchorError("文本不存在");
  const para = db
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.id, input.paragraphId))
    .get();
  if (!para || para.textId !== input.textId) throw new InvalidAnchorError("段落不存在");
}

/**
 * 收词：按 (userId, lemma) upsert user_words，并插入一条 context。
 * 保持「每次收词一条 context」的原语义（同一个词在不同位置出现各记一条）。
 */
export function saveWordAndContext(
  input: WordAnchor & { aiGloss?: string },
  userId: string,
): SaveResult {
  assertAnchor(input, userId);
  const { word, textId, paragraphId, start, end, quote, prefix, suffix, aiGloss } = input;
  const dictResult = lookup(word.trim());

  const lemmaForm = dictResult.lemmaForm || word.trim();
  const displayForm = word.trim();
  const phonetic = dictResult.entry?.phonetic ?? null;
  // 词典释义优先；词典查不到时只取 AI 主体段的短释义，绝不把句子地图写进卡片背面。
  const translation = dictResult.entry?.translation ?? cardGloss(aiGloss) ?? "(待补充释义)";
  const pos = dictResult.entry?.pos ?? null;
  const isPhrase = /\s/.test(displayForm) ? 1 : 0;

  const now = Date.now();
  const wordId = randomUUID();
  const contextId = randomUUID();
  let finalWordId: string = wordId;
  let finalStatus = "learning";
  let finalStarred = 0;
  let created = true;

  db.transaction((tx) => {
    const existing = tx
      .select()
      .from(userWords)
      // 唯一索引是 (user_id, lemma)：查重必须带归属，否则会把语境挂到别人的同名词条上
      .where(and(eq(userWords.userId, userId), eq(userWords.lemma, lemmaForm)))
      .get() as typeof userWords.$inferSelect | undefined;

    let resolvedWordId: string;
    if (existing) {
      resolvedWordId = existing.id;
      tx.update(userWords)
        .set({
          displayForm,
          phonetic: phonetic ?? existing.phonetic,
          translation: translation !== "(待补充释义)" ? translation : existing.translation,
          pos: pos ?? existing.pos,
          isPhrase,
          status: existing.status,
        })
        .where(eq(userWords.id, existing.id))
        .run();
      finalStatus = existing.status;
      finalStarred = existing.starred;
      created = false;
    } else {
      resolvedWordId = wordId;
      tx.insert(userWords)
        .values({
          id: wordId,
          userId,
          lemma: lemmaForm,
          displayForm,
          pos,
          phonetic,
          translation,
          note: null,
          createdAt: now,
          isPhrase,
        })
        .run();
    }
    finalWordId = resolvedWordId;

    tx.insert(contexts)
      .values({
        id: contextId,
        userWordId: resolvedWordId,
        textId,
        paragraphId,
        start,
        end,
        quote,
        prefix,
        suffix,
        aiGloss: aiGloss ?? null,
        createdAt: now,
      })
      .run();
  });

  return {
    ok: true,
    wordId: finalWordId,
    contextId,
    lemma: lemmaForm,
    displayForm,
    translation,
    phonetic,
    pos,
    status: finalStatus,
    starred: finalStarred,
    isPhrase: isPhrase === 1,
    created,
    contextCreated: true,
  };
}

/**
 * 把释义全文写进某条 context，并在词条释义还是占位符时补上 cardGloss() 短释义。
 * PATCH /api/contexts/[id] 与按锚点写回共用这一份规则。
 */
export function applyGlossToContext(contextId: string, gloss: string): void {
  const row = db.select().from(contexts).where(eq(contexts.id, contextId)).get();
  if (!row) throw new InvalidAnchorError("批注不存在");

  db.update(contexts).set({ aiGloss: gloss }).where(eq(contexts.id, contextId)).run();

  const short = cardGloss(gloss);
  const word = db.select().from(userWords).where(eq(userWords.id, row.userWordId)).get();
  if (word && short) {
    if (word.isPhrase === 1) {
      db.update(userWords).set({ translation: short }).where(eq(userWords.id, word.id)).run();
    } else if (word.translation === "(待补充释义)" || !word.translation) {
      db.update(userWords).set({ translation: short }).where(eq(userWords.id, word.id)).run();
    }
  }
}

/**
 * 按 (textId, paragraphId, start, end) 找当前账号最近一条 context。
 * 经 user_words 限定归属：修复前可能有别的账号写进来的脏批注，不能被当成自己的复用 / 覆盖。
 */
export function findContextByAnchor(input: WordAnchor, userId: string) {
  return db
    .select({
      id: contexts.id,
      userWordId: contexts.userWordId,
      aiGloss: contexts.aiGloss,
    })
    .from(contexts)
    .innerJoin(userWords, eq(userWords.id, contexts.userWordId))
    .where(
      and(
        eq(userWords.userId, userId),
        eq(contexts.textId, input.textId),
        eq(contexts.paragraphId, input.paragraphId),
        eq(contexts.start, input.start),
        eq(contexts.end, input.end),
      ),
    )
    .orderBy(desc(contexts.createdAt))
    .limit(1)
    .get();
}

/**
 * 按锚点「确保有批注」（幂等）：已有就原样返回，没有才补建词条 + context。
 *
 * 词在别的文章收过、但本文这一处没批注，是最容易踩空的场景：
 * savedWords 是全量词库，前端点词时命中 savedMap 就直接 return，
 * 于是「已收词 ✓」和「本文已存批注」对不上。这里让服务端按锚点裁决，
 * 重复点同一个位置也只会有一条 context。
 */
export function ensureContextByAnchor(
  input: WordAnchor & { aiGloss?: string },
  userId: string,
): SaveResult {
  assertAnchor(input, userId);
  const existing = findContextByAnchor(input, userId);
  if (existing) {
    // 顺手补一次释义：手动「收词」按钮可能带着刚生成的 AI 全文过来
    if (input.aiGloss && !existing.aiGloss) {
      applyGlossToContext(existing.id, input.aiGloss);
    }
    const word = db
      .select()
      .from(userWords)
      .where(eq(userWords.id, existing.userWordId))
      .get();
    return {
      ok: true,
      wordId: existing.userWordId,
      contextId: existing.id,
      lemma: word?.lemma ?? input.word.trim(),
      displayForm: word?.displayForm ?? input.word.trim(),
      translation: word?.translation ?? "",
      phonetic: word?.phonetic ?? null,
      pos: word?.pos ?? null,
      status: word?.status ?? "learning",
      starred: word?.starred ?? 0,
      isPhrase: word?.isPhrase === 1,
      created: false,
      contextCreated: false,
    };
  }
  return saveWordAndContext(input, userId);
}

/**
 * AI 释义写回（幂等）：确保锚点有 context，再把全文写进 ai_gloss。
 *
 * 「补建」是这次修复的关键：点词时如果这个词在别的文章里已经收过，
 * 前端 savedMap 命中、不会为本次出现建 context；自动收词关闭时同理。
 * 旧逻辑在这里静默 return，答案就丢了。现在服务端兜底，不让任何一次
 * 已经花过钱的 AI 结果无处可去。追问 / 重试走同一条路，只覆盖不新增。
 */
export function persistGlossByAnchor(
  input: WordAnchor & { aiGloss: string },
  userId: string,
): SaveResult {
  const result = ensureContextByAnchor(input, userId);
  if (!result.contextCreated) applyGlossToContext(result.contextId, input.aiGloss);
  return result;
}

/**
 * P32：学习档案与讲解事件的数据库读写。
 *
 * 只新增表，不动任何已有结构；全部用原生参数化 SQL（与 settings-store 一致，
 * 也方便 CommonJS 脚本复用）。所有查询都带 user_id，画像和笔记只有本人可见。
 */
import { randomUUID } from "node:crypto";
import { sqlite } from "../db/sqlite";
import { allSettings } from "./settings-store";
import { frequencyRank, lemma as lemmaOf } from "./dict";
import { isPersonalizedOn } from "./learner/flag";
import { narrowAskKind } from "./learner/ask-kind";
import { normalizeSurvey, surveyPrior, type SurveyAnswers } from "./learner/survey";
import { buildLearnerBlock, hasUsableProfile } from "./learner/profile-text";
import { computeBehaviorStats, mergeProfile } from "./learner/model";
import type { AskKind, BehaviorStats, Feedback, LearnerEvent, LearnerLevel } from "./learner/types";
import { EMPTY_BEHAVIOR_STATS } from "./learner/types";
import { validateNote, type NotePromptInput } from "./learner/note";
import { formatRecentFeedback, RECENT_FEEDBACK_DAYS } from "./learner/recent-feedback";

export type LearnerRow = {
  user_id: string;
  survey: string | null;
  survey_completed_at: number | null;
  survey_dismissed_at: number | null;
  show_feedback: number;
  stats: string | null;
  stats_updated_at: number | null;
  note: string | null;
  note_updated_at: number | null;
  note_user_edited: number;
  note_lookup_cursor: number;
  note_last_error: string | null;
  memory_reset_at: number;
  updated_at: number;
  note_update_kind: string | null;
};

const SELECT_ONE = "SELECT * FROM learner_profiles WHERE user_id = ?";
/** 行为推断缓存 6 小时；单次讲解请求只查一行 + 最多 500 条事件 */
const STATS_TTL_MS = 6 * 3600 * 1000;

export function getLearner(userId: string): LearnerRow {
  const found = sqlite.prepare(SELECT_ONE).get(userId) as LearnerRow | undefined;
  if (found) return found;
  sqlite
    .prepare("INSERT OR IGNORE INTO learner_profiles (user_id, updated_at) VALUES (?, ?)")
    .run(userId, Date.now());
  return sqlite.prepare(SELECT_ONE).get(userId) as LearnerRow;
}

/** DB 里的问卷是 JSON，读出来再过一遍白名单，脏数据不会进提示词 */
export function surveyOf(row: LearnerRow): SurveyAnswers | null {
  if (!row.survey) return null;
  try {
    const a = normalizeSurvey(JSON.parse(row.survey));
    return Object.keys(a).length > 0 ? a : null;
  } catch {
    return null;
  }
}

/** 首页提示卡片 / /welcome 用：没提交过、也没点过「以后再说」 */
export function needsSurvey(row: LearnerRow): boolean {
  return row.survey_completed_at === null && row.survey_dismissed_at === null;
}

export function saveSurvey(userId: string, input: unknown): SurveyAnswers {
  const answers = normalizeSurvey(input);
  sqlite
    .prepare(
      `INSERT INTO learner_profiles (user_id, survey, survey_completed_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         survey = excluded.survey,
         survey_completed_at = excluded.survey_completed_at,
         updated_at = excluded.updated_at`,
    )
    .run(userId, JSON.stringify(answers), Date.now(), Date.now());
  return answers;
}

export function dismissSurvey(userId: string): void {
  getLearner(userId);
  sqlite
    .prepare("UPDATE learner_profiles SET survey_dismissed_at = ?, updated_at = ? WHERE user_id = ?")
    .run(Date.now(), Date.now(), userId);
}

export function setShowFeedback(userId: string, show: boolean): void {
  getLearner(userId);
  sqlite
    .prepare("UPDATE learner_profiles SET show_feedback = ?, updated_at = ? WHERE user_id = ?")
    .run(show ? 1 : 0, Date.now(), userId);
}

/* ------------------------------------------------------------------ *
 * 归属校验：contextId / textId 都来自客户端，写入事件前必须确认属于本人。
 * 不属于一律存 null（阶段二算追问率依赖这两个字段，不能串到别人身上）。
 * ------------------------------------------------------------------ */
function ownedRefs(
  userId: string,
  contextId?: string | null,
  textId?: string | null,
): { contextId: string | null; textId: string | null; textCefr: string | null } {
  const ctx = contextId
    ? sqlite
        .prepare(
          `SELECT c.id FROM contexts c JOIN user_words w ON w.id = c.user_word_id
           WHERE c.id = ? AND w.user_id = ?`,
        )
        .get(contextId, userId)
    : null;
  const txt = textId
    ? (sqlite
        .prepare("SELECT cefr_level FROM texts WHERE id = ? AND user_id = ?")
        .get(textId, userId) as { cefr_level: string | null } | undefined)
    : undefined;
  return {
    contextId: ctx ? (contextId as string) : null,
    textId: txt ? (textId as string) : null,
    textCefr: txt?.cefr_level ?? null,
  };
}

export type PromptProfile = {
  level: LearnerLevel | null;
  survey: SurveyAnswers | null;
  stats: BehaviorStats | null;
  note: string | null;
  showFeedback: boolean;
  personalized: boolean;
};

/** 6 小时内复用缓存，过期就按最近 90 天、清空记忆之后的事件重算 */
function cachedStats(row: LearnerRow, now: number): BehaviorStats {
  if (row.stats && row.stats_updated_at && now - row.stats_updated_at < STATS_TTL_MS) {
    try {
      return JSON.parse(row.stats) as BehaviorStats;
    } catch {
      /* 缓存坏了就重算 */
    }
  }
  const s = computeBehaviorStats(loadEvents(row.user_id, now), now, row.memory_reset_at);
  sqlite
    .prepare("UPDATE learner_profiles SET stats = ?, stats_updated_at = ?, updated_at = ? WHERE user_id = ?")
    .run(JSON.stringify(s), now, now, row.user_id);
  return s;
}

/**
 * 一次讲解请求前读一次档案。只查一行 + 纯函数换算，远低于 §0.4 的 20ms 预算。
 * 开关关闭时仍返回档案数据（问卷照常收集），只是不把画像交给模型。
 */
export function getProfileForPrompt(userId: string): PromptProfile {
  const row = getLearner(userId);
  const survey = surveyOf(row);
  const stats = cachedStats(row, Date.now());
  const prior = survey ? surveyPrior(survey) : null;
  return {
    level: mergeProfile(prior, stats),
    survey,
    stats,
    note: row.note,
    showFeedback: row.show_feedback === 1,
    personalized: isPersonalizedOn(allSettings(userId), process.env),
  };
}

/** §0.4：发给模型的画像文本不超过 600 字符，由 buildLearnerBlock 保证 */
export function learnerBlockFor(userId: string): { block: string; detailed: boolean; personalized: boolean } {
  const p = getProfileForPrompt(userId);
  if (!p.personalized) return { block: "", detailed: false, personalized: false };
  const recent = recentFeedbackFor(userId);
  // 没有可依据的档案：按个性化关闭处理，用旧的「同句第几次」规则兜底
  if (!hasUsableProfile({ survey: p.survey, stats: p.stats, note: p.note, recentFeedbackCount: recent.count })) {
    return { block: "", detailed: false, personalized: false };
  }
  return {
    block: buildLearnerBlock({
      level: p.level,
      survey: p.survey,
      stats: p.stats,
      note: p.note,
      recentFeedback: recent.lines,
    }),
    detailed: p.survey?.stylePref === "detailed",
    personalized: true,
  };
}

/**
 * P34 F2：最近 30 天的反馈，不限文章。lines 是「三种评价各最近一次」整理出的几行，
 * count 是这 30 天的反馈次数（判断「有没有可依据的档案」用）。
 */
export function recentFeedbackFor(userId: string, now: number = Date.now()): { lines: string[]; count: number } {
  const row = getLearner(userId);
  const since = now - RECENT_FEEDBACK_DAYS * 24 * 3600 * 1000;
  const rows = sqlite
    .prepare(
      `SELECT e.feedback, e.feedback_at, e.ask_kind, e.is_phrase, a.ask_label, a.answer_text
         FROM explain_events e LEFT JOIN explain_answers a ON a.event_id = e.id
        WHERE e.user_id = ? AND e.kind = 'explain' AND e.feedback IS NOT NULL
          AND e.created_at > ? AND e.feedback_at > ?
        ORDER BY e.feedback_at DESC LIMIT 50`,
    )
    .all(userId, row.memory_reset_at, since) as {
    feedback: string;
    feedback_at: number;
    ask_kind: string | null;
    is_phrase: number;
    ask_label: string | null;
    answer_text: string | null;
  }[];
  const lines = formatRecentFeedback(
    rows.map((r) => ({
      feedback: r.feedback,
      feedbackAt: r.feedback_at,
      askKind: r.ask_kind,
      askLabel: r.ask_label,
      isPhrase: r.is_phrase === 1,
      answerText: r.answer_text,
    })),
  );
  return { lines, count: rows.length };
}

/** P34 F4：一条批注下所有保存过的回答（回看时对上反馈用），按时间先后 */
export function answersForContext(userId: string, contextId: string): {
  answerId: string;
  askLabel: string | null;
  text: string;
  feedback: string | null;
  createdAt: number;
}[] {
  const rows = sqlite
    .prepare(
      `SELECT a.event_id, a.ask_label, a.answer_text, e.feedback, a.created_at
         FROM explain_answers a JOIN explain_events e ON e.id = a.event_id
        WHERE a.user_id = ? AND a.context_id = ?
        ORDER BY a.created_at ASC`,
    )
    .all(userId, contextId) as {
    event_id: string;
    ask_label: string | null;
    answer_text: string;
    feedback: string | null;
    created_at: number;
  }[];
  return rows.map((r) => ({
    answerId: r.event_id,
    askLabel: r.ask_label,
    text: r.answer_text,
    feedback: r.feedback,
    createdAt: r.created_at,
  }));
}

export type ExplainEventInput = {
  userId: string;
  askKind: AskKind;
  via: "reader" | "extension";
  word: string;
  contextId?: string | null;
  textId?: string | null;
  dictHit?: boolean | null;
  repeatCount?: number | null;
};

/** 写一条讲解事件；返回 id，同时就是「这段回答」的 X-RF-Answer-Id */
export function logExplain(input: ExplainEventInput): string {
  const id = randomUUID();
  const word = input.word.slice(0, 120);
  const refs = ownedRefs(input.userId, input.contextId, input.textId);
  sqlite
    .prepare(
      `INSERT INTO explain_events
         (id, user_id, kind, ask_kind, via, word, lemma, is_phrase, dict_hit, repeat_count,
          text_id, text_cefr, context_id, created_at)
       VALUES (?, ?, 'explain', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      narrowAskKind(input.askKind),
      input.via,
      word,
      safeLemma(word),
      /\s/.test(word.trim()) ? 1 : 0,
      typeof input.dictHit === "boolean" ? (input.dictHit ? 1 : 0) : null,
      typeof input.repeatCount === "number" ? input.repeatCount : null,
      refs.textId,
      refs.textCefr,
      refs.contextId,
      Date.now(),
    );
  return id;
}

export type LookupEventInput = {
  userId: string;
  word: string;
  lemma?: string | null;
  via: "reader" | "extension";
  contextId?: string | null;
  textId?: string | null;
  repeatCount?: number | null;
  dictHit?: boolean | null;
  isPhrase?: boolean;
};

/** 写一条查词事件。词频排名查不到、词典库没导入都不影响查词本身。 */
export function logLookup(input: LookupEventInput): string {
  const id = randomUUID();
  const word = input.word.slice(0, 120);
  const lemma = (input.lemma ?? word).slice(0, 120);
  const refs = ownedRefs(input.userId, input.contextId, input.textId);
  let freqRank: number | null = null;
  try {
    freqRank = frequencyRank(lemma);
  } catch {
    /* 词典库缺失时保持 null */
  }
  const isPhrase = input.isPhrase ?? /\s/.test(word.trim());
  sqlite
    .prepare(
      `INSERT INTO explain_events
         (id, user_id, kind, via, word, lemma, freq_rank, is_phrase, dict_hit,
          repeat_count, text_id, text_cefr, context_id, created_at)
       VALUES (?, ?, 'lookup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.userId,
      input.via,
      word,
      lemma,
      freqRank,
      isPhrase ? 1 : 0,
      typeof input.dictHit === "boolean" ? (input.dictHit ? 1 : 0) : null,
      typeof input.repeatCount === "number" ? input.repeatCount : null,
      refs.textId,
      refs.textCefr,
      refs.contextId,
      Date.now(),
    );
  return id;
}

/** P34：讲解事件也记原形（词典库没导入时退回小写原词） */
function safeLemma(word: string): string {
  try {
    return lemmaOf(word).toLowerCase().slice(0, 120);
  } catch {
    return word.toLowerCase().slice(0, 120);
  }
}

/* ------------------------------------------------------------------ *
 * P34 F1：每段回答原文，以及讲解记录对上批注。
 * ------------------------------------------------------------------ */

/** 讲解完整结束后存一行；同一个 answerId 只存一次 */
export function saveAnswer(input: {
  eventId: string;
  userId: string;
  contextId: string | null;
  askLabel?: string;
  text: string;
}): void {
  if (!input.text.trim()) return;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO explain_answers (event_id, user_id, context_id, ask_label, answer_text, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM explain_events WHERE id = ? AND user_id = ?)`,
    )
    .run(input.eventId, input.userId, input.contextId, input.askLabel ?? null, input.text, Date.now(), input.eventId, input.userId);
}

/**
 * 讲解结束时确定它属于哪条批注，并补写到讲解事件上。返回最终的批注 id（可能为 null）。
 * 已有 context_id（请求里带了且属于本人）就用它；否则按锚点在本人的批注里找。
 */
export function linkExplainContext(
  userId: string,
  eventId: string,
  textId: string | undefined,
  anchor: { paragraphId: string; start: number; end: number } | undefined,
): string | null {
  const ev = sqlite
    .prepare("SELECT context_id FROM explain_events WHERE id = ? AND user_id = ?")
    .get(eventId, userId) as { context_id: string | null } | undefined;
  if (!ev) return null;
  if (ev.context_id) return ev.context_id;
  if (!textId || !anchor) return null;
  const hit = sqlite
    .prepare(
      `SELECT c.id FROM contexts c JOIN user_words w ON w.id = c.user_word_id
        WHERE w.user_id = ? AND c.text_id = ? AND c.paragraph_id = ? AND c.start = ? AND c.end = ?
        ORDER BY c.created_at DESC LIMIT 1`,
    )
    .get(userId, textId, anchor.paragraphId, anchor.start, anchor.end) as { id: string } | undefined;
  if (!hit) return null;
  sqlite.prepare("UPDATE explain_events SET context_id = ? WHERE id = ? AND context_id IS NULL").run(hit.id, eventId);
  return hit.id;
}

/**
 * 保存批注时兜底：同一用户、同一篇文章、选中同一段文字、10 分钟内还没对上批注的讲解，补上批注 id。
 * （讲解比批注先发出、讲解结束时批注还没保存好的情况）
 */
export function backfillExplainContext(userId: string, contextId: string, textId: string, quote: string): void {
  const since = Date.now() - 10 * 60 * 1000;
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE explain_events SET context_id = ?
          WHERE user_id = ? AND kind = 'explain' AND context_id IS NULL AND text_id = ?
            AND lower(word) = lower(?) AND created_at > ?`,
      )
      .run(contextId, userId, textId, quote.slice(0, 120), since);
    sqlite
      .prepare(
        `UPDATE explain_answers SET context_id = ?
          WHERE user_id = ? AND context_id IS NULL
            AND event_id IN (SELECT id FROM explain_events WHERE user_id = ? AND context_id = ?)`,
      )
      .run(contextId, userId, userId, contextId);
  })();
}

/** 反馈可改选，以最后一次为准；事件不存在 / 不属于本人 / 不是讲解都返回 false */
export function setFeedback(userId: string, eventId: string, feedback: Feedback): boolean {
  const row = sqlite
    .prepare("SELECT kind FROM explain_events WHERE id = ? AND user_id = ?")
    .get(eventId, userId) as { kind: string } | undefined;
  if (!row || row.kind !== "explain") return false;
  sqlite.transaction(() => {
    sqlite
      .prepare("UPDATE explain_events SET feedback = ?, feedback_at = ? WHERE id = ?")
      .run(feedback, Date.now(), eventId);
    // P34 F5：统计缓存立即失效，下一次讲解的「以往反馈」按最新数据计算
    sqlite.prepare("UPDATE learner_profiles SET stats_updated_at = NULL WHERE user_id = ?").run(userId);
  })();
  return true;
}

/** 「再查 N 个词」的计数：清空记忆之前的事件不算 */
export function lookupCountSince(userId: string, since: number): number {
  const r = sqlite
    .prepare(
      "SELECT COUNT(*) n FROM explain_events WHERE user_id = ? AND kind = 'lookup' AND created_at > ?",
    )
    .get(userId, since) as { n: number };
  return Number(r.n);
}

type EventRow = {
  kind: string;
  ask_kind: string | null;
  freq_rank: number | null;
  is_phrase: number;
  repeat_count: number | null;
  text_cefr: string | null;
  feedback: string | null;
  created_at: number;
  context_id: string | null;
};

/* ------------------------------------------------------------------ *
 * P32 阶段三：老师笔记（F3）与「清空 AI 记忆」（F6）的读写。
 * 只新增列值写入，不删 explain_events、不动已有字段与接口结构。
 * ------------------------------------------------------------------ */

/**
 * 用户手改笔记（F6「这不准确」）：按 §5.1 只校验长度和 Markdown，
 * 置 note_user_edited=1。不动 note_updated_at / 游标，让下次 AI 更新时
 * 把这段内容作为重要参考改写，而不是把它当成「刚更新过」跳过。
 */
export function editNote(userId: string, text: string): string {
  const v = validateNote(text, "user");
  if (!v.ok) throw new Error(v.reason);
  getLearner(userId);
  sqlite
    .prepare(
      `UPDATE learner_profiles SET note = ?, note_user_edited = 1, note_update_kind = 'user', updated_at = ?
       WHERE user_id = ?`,
    )
    .run(v.note, Date.now(), userId);
  return v.note;
}

/**
 * 生成成功后落库：记下来源、清掉错误、把「用户改过」标记归 0。
 * P34：新动静按 note_updated_at 之后的时间计算，note_lookup_cursor 不再写入（保留列）。
 */
export function saveNote(userId: string, note: string, kind: "nightly" = "nightly"): void {
  const now = Date.now();
  sqlite
    .prepare(
      `UPDATE learner_profiles
         SET note = ?, note_updated_at = ?, note_update_kind = ?,
             note_user_edited = 0, note_last_error = NULL, updated_at = ?
       WHERE user_id = ?`,
    )
    .run(note, now, kind, now, userId);
}

/**
 * P34 F3：自上次整理以来的新动静（不限文章）：新的查词、新的讲解，
 * 以及上次整理之后才点的（或改选的）反馈。从没整理过时从「清空记忆」算起。
 */
export function newEventsSinceNote(userId: string): number {
  const row = getLearner(userId);
  const base = Math.max(row.note_updated_at ?? 0, row.memory_reset_at);
  const r = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM explain_events WHERE user_id = ? AND created_at > ?) +
         (SELECT COUNT(*) FROM explain_events WHERE user_id = ? AND created_at <= ? AND feedback_at > ?) AS n`,
    )
    .get(userId, base, userId, base, base) as { n: number };
  return Number(r.n);
}

/** P34 F3：每晚整理用的「带回答的反馈」：所有文章里最近 30 组，从新到旧 */
export function answeredFeedbackFor(userId: string, limit = 30): {
  feedback: string;
  askKind: string | null;
  askLabel: string | null;
  isPhrase: boolean;
  answerText: string | null;
}[] {
  const row = getLearner(userId);
  const rows = sqlite
    .prepare(
      `SELECT e.feedback, e.ask_kind, e.is_phrase, a.ask_label, a.answer_text
         FROM explain_events e LEFT JOIN explain_answers a ON a.event_id = e.id
        WHERE e.user_id = ? AND e.kind = 'explain' AND e.feedback IS NOT NULL AND e.created_at > ?
        ORDER BY e.feedback_at DESC LIMIT ?`,
    )
    .all(userId, row.memory_reset_at, limit) as {
    feedback: string;
    ask_kind: string | null;
    is_phrase: number;
    ask_label: string | null;
    answer_text: string | null;
  }[];
  return rows.map((r) => ({
    feedback: r.feedback,
    askKind: r.ask_kind,
    askLabel: r.ask_label,
    isPhrase: r.is_phrase === 1,
    answerText: r.answer_text,
  }));
}

/**
 * P34 F6：按用途删除过期记录（一个事务）。返回各删了多少行。
 * - 讲解记录：超过 30 天且已被整理进老师笔记的；无论如何超过 90 天的
 * - 查词记录：超过 90 天的
 * 回答原文随外键一起删除；再按「讲解记录已不存在」兜底删一次。
 */
export function purgeExpiredEvents(cutoffs: { explain: number; explainMax: number; lookup: number }): {
  explain: number;
  lookup: number;
  answers: number;
} {
  return sqlite.transaction(() => {
    const e1 = sqlite
      .prepare(
        `DELETE FROM explain_events
          WHERE kind = 'explain' AND created_at < ?
            AND created_at < (SELECT COALESCE(p.note_updated_at, 0) FROM learner_profiles p WHERE p.user_id = explain_events.user_id)`,
      )
      .run(cutoffs.explain).changes;
    const e2 = sqlite.prepare("DELETE FROM explain_events WHERE kind = 'explain' AND created_at < ?").run(cutoffs.explainMax).changes;
    const l = sqlite.prepare("DELETE FROM explain_events WHERE kind = 'lookup' AND created_at < ?").run(cutoffs.lookup).changes;
    const a = sqlite
      .prepare("DELETE FROM explain_answers WHERE event_id NOT IN (SELECT id FROM explain_events)")
      .run().changes;
    return { explain: e1 + e2, lookup: l, answers: a };
  })();
}

/** 校验失败 / 模型出错：只记日志和 note_last_error，游标不动，下次自动重试 */
export function recordNoteError(userId: string, reason: string): void {
  getLearner(userId);
  sqlite
    .prepare("UPDATE learner_profiles SET note_last_error = ?, updated_at = ? WHERE user_id = ?")
    .run(String(reason).slice(0, 300), Date.now(), userId);
}

/**
 * F6「清空 AI 记忆」：清掉笔记和行为推断缓存，之后从问卷重新开始。
 * 查词记录本身不删 —— 用 memory_reset_at 让画像只算这之后的事件。
 */
export function resetMemory(userId: string): void {
  getLearner(userId);
  const now = Date.now();
  sqlite
    .prepare(
      `UPDATE learner_profiles
         SET stats = NULL, stats_updated_at = NULL,
             note = NULL, note_updated_at = NULL, note_user_edited = 0, note_update_kind = NULL,
             note_lookup_cursor = 0, note_last_error = NULL,
             memory_reset_at = ?, updated_at = ?
       WHERE user_id = ?`,
    )
    .run(now, now, userId);
}

/** 拼 buildNotePrompt 的输入：旧笔记 + 缓存的统计 + 最近问答摘要 */
export function notePromptInputFor(userId: string): NotePromptInput {
  const row = getLearner(userId);
  const stats = getProfileForPrompt(userId).stats ?? EMPTY_BEHAVIOR_STATS;
  const rows = sqlite
    .prepare(
      `SELECT word, ask_kind, feedback, repeat_count FROM explain_events
       WHERE user_id = ? AND created_at > ?
       ORDER BY created_at DESC LIMIT 30`,
    )
    .all(userId, row.memory_reset_at) as {
    word: string | null;
    ask_kind: string | null;
    feedback: string | null;
    repeat_count: number | null;
  }[];
  const recent = rows.map((r) => ({
    word: String(r.word ?? ""),
    ...(r.ask_kind ? { askKind: String(r.ask_kind) } : {}),
    ...(r.feedback ? { feedback: String(r.feedback) } : {}),
    ...(typeof r.repeat_count === "number" ? { repeatCount: r.repeat_count } : {}),
  }));
  return {
    oldNote: row.note,
    userEdited: row.note_user_edited === 1,
    stats,
    recent,
  };
}

/** 最近 90 天、最多 500 条，且只在「清空记忆」之后 */
export function loadEvents(userId: string, now: number = Date.now()): LearnerEvent[] {
  const row = getLearner(userId);
  const rows = sqlite
    .prepare(
      `SELECT * FROM explain_events
       WHERE user_id = ? AND created_at >= ? AND created_at > ?
       ORDER BY created_at DESC LIMIT 500`,
    )
    .all(userId, now - 90 * 24 * 3600 * 1000, row.memory_reset_at) as EventRow[];
  return rows.map((r) => ({
    kind: r.kind === "explain" ? "explain" : "lookup",
    askKind: (r.ask_kind as AskKind) ?? undefined,
    freqRank: r.freq_rank,
    isPhrase: r.is_phrase === 1,
    repeatCount: r.repeat_count,
    textCefr: r.text_cefr,
    feedback: (r.feedback as Feedback) ?? null,
    createdAt: r.created_at,
    contextId: r.context_id,
  }));
}

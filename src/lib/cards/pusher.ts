/**
 * 草稿卡推送到墨墨（P33 spec §7.5，PRD F5）。
 *
 * 只有用户在「待推送」里点推送才会走到这里（spec §0.4）。要点：
 * - 每个用户同一时间一个任务；任务写在 push_jobs 里，服务重启后下一次查询状态时接着跑。
 * - 墨墨的写接口限频：10 秒 20 次、60 秒 40 次、间隔 ≥500ms（rate-limit.ts），读也一并计入。
 * - 墨墨删不掉卡片，所以「不重复建卡」是硬约束：
 *   · 建卡前先把卡标成 pushing；
 *   · 服务重启遗留的 pushing 卡、以及建卡请求出错（5xx / 超时，可能已经成功）之后，
 *     都先去章节里找一张内容完全相同、又不属于任何已推送记录的卡，找到就认领，找不到才重建。
 *   选这个办法而不是在卡面里塞隐藏标记：不污染用户看到的卡片。
 * - 429 / 5xx / 网络错误：等 5 秒、10 秒、20 秒，最多重试 3 次；其它 4xx：这张卡标失败，继续下一张。
 * - 每天最多创建 600 条（按墨墨文档保守估算），到了就暂停任务并提示。
 */
import { randomUUID } from "node:crypto";
import { sqlite } from "@/db/sqlite";
import { createCard, createChapter, getCard, listChapters, MarkjiError } from "@/lib/markji";
import { markjiTokenFor } from "@/lib/user-secrets";
import { setSetting } from "@/lib/settings-store";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { cardQuotaDay } from "./quota";
import { cardsEnabled } from "./flags";
import { siteCardsSettings } from "./store";

export const MARKJI_DAILY_CREATE_CAP = 600;
export const RETRY_DELAYS_MS = [5000, 10000, 20000];
export const CHAPTER_NAME_MAX = 40;
/** 找已存在的卡时最多核对章节末尾的几张未认领的卡 */
const CLAIM_SCAN = 10;

export const KEY_DECK = "markji.cardsDeck";
export const KEY_CHAPTER = "markji.cardsChapter";
export const KEY_MODE = "markji.cardsChapterMode";

type Who = { id: string; isOwner: boolean };
export type ChapterMode = "fixed" | "per_article";

export type PushOutcome =
  | { ok: true; jobId: string }
  | { ok: false; status: number; error: string; jobId?: string };

type Deps = { sleep: (ms: number) => Promise<void> };
const realDeps: Deps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// ---------- 限速：每个用户（= 每个墨墨 Token）一个滑动窗口 ----------
const limiters = new Map<string, RateLimiter>();
async function paced<T>(userId: string, deps: Deps, fn: () => Promise<T>): Promise<T> {
  let rl = limiters.get(userId);
  if (!rl) limiters.set(userId, (rl = createRateLimiter()));
  const now = Date.now();
  const at = rl.nextAt(now);
  if (at > now) await deps.sleep(at - now);
  rl.record(Math.max(at, now));
  return fn();
}

// ---------- 启动 ----------

export function startPush(
  user: Who,
  body: { cardIds: unknown; deckId: unknown; chapterMode: unknown; chapterId?: unknown },
  deps: Deps = realDeps,
): PushOutcome {
  if (!cardsEnabled(siteCardsSettings())) return { ok: false, status: 403, error: "做卡功能已关闭" };
  const token = markjiTokenFor(user);
  if (!token) {
    return { ok: false, status: 400, error: "未配置墨墨 Token，请在右上角头像 → 设置里填写后再推送" };
  }
  const deckId = typeof body.deckId === "string" ? body.deckId.trim() : "";
  const mode: ChapterMode | null =
    body.chapterMode === "fixed" || body.chapterMode === "per_article" ? body.chapterMode : null;
  const chapterId = typeof body.chapterId === "string" ? body.chapterId.trim() : "";
  const cardIds = Array.isArray(body.cardIds)
    ? [...new Set(body.cardIds.filter((x): x is string => typeof x === "string" && x.length > 0))]
    : [];
  if (!deckId) return { ok: false, status: 400, error: "请先选择牌组" };
  if (!mode) return { ok: false, status: 400, error: "章节方式不对" };
  if (mode === "fixed" && !chapterId) return { ok: false, status: 400, error: "请先选择章节" };
  if (cardIds.length === 0) return { ok: false, status: 400, error: "没有要推送的卡片" };
  if (cardIds.length > 500) return { ok: false, status: 400, error: "一次最多推送 500 张" };

  const active = sqlite
    .prepare("SELECT id FROM push_jobs WHERE user_id = ? AND status = 'running' LIMIT 1")
    .get(user.id) as { id: string } | undefined;
  if (active) {
    return { ok: false, status: 409, error: "已有一个推送任务在进行，等它结束再推", jobId: active.id };
  }

  const rows = sqlite
    .prepare(`SELECT id, status FROM cards WHERE user_id = ? AND id IN (${cardIds.map(() => "?").join(",")})`)
    .all(user.id, ...cardIds) as { id: string; status: string }[];
  if (rows.length !== cardIds.length) return { ok: false, status: 404, error: "有卡片不存在" };
  if (rows.some((r) => r.status !== "draft")) return { ok: false, status: 400, error: "只有草稿卡可以推送" };

  const jobId = randomUUID();
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO push_jobs (id, user_id, deck_id, chapter_mode, chapter_id, card_ids, done, failed, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'running', ?, ?)`,
    )
    .run(jobId, user.id, deckId, mode, mode === "fixed" ? chapterId : null, JSON.stringify(cardIds), now, now);

  // 记住这次的选择，作为下次的默认值
  setSetting(KEY_DECK, deckId, user.id);
  setSetting(KEY_MODE, mode, user.id);
  if (mode === "fixed") setSetting(KEY_CHAPTER, chapterId, user.id);

  launch(jobId, user, token, deps);
  return { ok: true, jobId };
}

// ---------- 状态 ----------

export type JobStatus = {
  jobId: string;
  status: "running" | "paused" | "done" | "error";
  done: number;
  failed: number;
  total: number;
  error: string | null;
  failures: { cardId: string; error: string }[];
};

type JobRow = {
  id: string; user_id: string; deck_id: string; chapter_mode: ChapterMode; chapter_id: string | null;
  card_ids: string; done: number; failed: number; status: JobStatus["status"]; error: string | null;
};

export function getJobStatus(user: Who, jobId: string, deps: Deps = realDeps): JobStatus | null {
  const job = sqlite.prepare("SELECT * FROM push_jobs WHERE id = ? AND user_id = ?").get(jobId, user.id) as
    | JobRow
    | undefined;
  if (!job) return null;
  // 服务重启后：状态还是 running 但进程里没有它的执行器 → 接着跑
  if (job.status === "running" && !runners.has(job.id)) {
    const token = markjiTokenFor(user);
    if (token) launch(job.id, user, token, deps);
  }
  const ids = JSON.parse(job.card_ids) as string[];
  const failures = sqlite
    .prepare(
      `SELECT id AS cardId, push_error AS error FROM cards
        WHERE user_id = ? AND push_error IS NOT NULL AND status = 'draft'
          AND id IN (${ids.map(() => "?").join(",") || "''"})`,
    )
    .all(user.id, ...ids) as { cardId: string; error: string }[];
  return {
    jobId: job.id,
    status: job.status,
    done: job.done,
    failed: job.failed,
    total: ids.length,
    error: job.error,
    failures,
  };
}

/** 这个用户正在跑的任务（刷新页面后恢复进度条用） */
export function activeJobId(userId: string): string | null {
  const row = sqlite
    .prepare("SELECT id FROM push_jobs WHERE user_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1")
    .get(userId) as { id: string } | undefined;
  return row?.id ?? null;
}

// ---------- 执行器 ----------

const runners = new Map<string, Promise<void>>();

function launch(jobId: string, user: Who, token: string, deps: Deps): void {
  if (runners.has(jobId)) return;
  const p = runJob(jobId, user, token, deps)
    .catch((err) => {
      console.error("[cards] 推送任务异常:", err);
      finishJob(jobId, "error", err instanceof Error ? err.message : "推送失败");
    })
    .finally(() => runners.delete(jobId));
  runners.set(jobId, p);
}

/** 测试用：等某个任务的执行器跑完 */
export function whenJobSettled(jobId: string): Promise<void> {
  return runners.get(jobId) ?? Promise.resolve();
}

function finishJob(jobId: string, status: JobStatus["status"], error: string | null): void {
  sqlite
    .prepare("UPDATE push_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
    .run(status, error, Date.now(), jobId);
}

type CardRow = {
  id: string; set_id: string; content: string; status: string; user_word_id: string; text_title: string | null;
};

function loadCard(userId: string, id: string): CardRow | undefined {
  return sqlite
    .prepare(
      `SELECT k.id, k.set_id, k.content, k.status, s.user_word_id, t.title AS text_title
         FROM cards k JOIN card_sets s ON s.id = k.set_id LEFT JOIN texts t ON t.id = s.text_id
        WHERE k.id = ? AND k.user_id = ?`,
    )
    .get(id, userId) as CardRow | undefined;
}

function createdToday(userId: string): number {
  const start = Date.parse(`${cardQuotaDay()}T00:00:00+08:00`);
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM exports e JOIN user_words w ON w.id = e.user_word_id
        WHERE w.user_id = ? AND e.target = 'markji' AND e.status = 'done' AND e.pushed_at >= ?`,
    )
    .get(userId, start) as { n: number };
  return row.n;
}

async function runJob(jobId: string, user: Who, token: string, deps: Deps): Promise<void> {
  const job = sqlite.prepare("SELECT * FROM push_jobs WHERE id = ?").get(jobId) as JobRow;
  const ids = JSON.parse(job.card_ids) as string[];
  const chapterCache = new Map<string, string>(); // 章节名 → 章节 id（per_article）
  let chaptersLoaded = false;

  const chapterFor = async (card: CardRow): Promise<string> => {
    if (job.chapter_mode === "fixed") return job.chapter_id as string;
    const name = (card.text_title?.trim() || "未命名文章").slice(0, CHAPTER_NAME_MAX);
    const hit = chapterCache.get(name);
    if (hit) return hit;
    if (!chaptersLoaded) {
      // 墨墨删不掉章节：建之前必须先查同名
      const existing = await withRetry(user.id, deps, () => listChapters(job.deck_id, token));
      for (const c of existing) if (!chapterCache.has(c.name)) chapterCache.set(c.name, c.id);
      chaptersLoaded = true;
      const again = chapterCache.get(name);
      if (again) return again;
    }
    const made = await withRetry(user.id, deps, () => createChapter(job.deck_id, name, token));
    chapterCache.set(name, made.id);
    return made.id;
  };

  for (const id of ids) {
    const card = loadCard(user.id, id);
    if (!card) continue;
    if (card.status === "pushed") continue; // 重启后接着跑：已经推过的不再处理
    if (card.status !== "draft" && card.status !== "pushing") continue;

    if (createdToday(user.id) >= MARKJI_DAILY_CREATE_CAP) {
      finishJob(jobId, "paused", `今天已经推送 ${MARKJI_DAILY_CREATE_CAP} 张卡片，到墨墨的每日上限了，明天再继续`);
      return;
    }
    if (card.content.includes("@AUDIO:")) {
      failCard(jobId, id, "这张卡的音频还没有生成，暂时不能推送");
      continue;
    }

    sqlite.prepare("UPDATE cards SET status = 'pushing', push_error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
    const resumed = card.status === "pushing";
    try {
      const chapterId = await chapterFor(card);
      let cardId: string | null = resumed ? await findExisting(user.id, deps, job.deck_id, chapterId, card.content, token) : null;
      if (!cardId) cardId = await createWithRetry(user.id, deps, job.deck_id, chapterId, card.content, token);
      markPushed(jobId, card, job.deck_id, chapterId, cardId);
    } catch (err) {
      const msg = err instanceof MarkjiError ? `${err.code ?? ""} ${err.message}`.trim() : String(err instanceof Error ? err.message : err);
      failCard(jobId, id, msg.slice(0, 300));
    }
  }
  finishJob(jobId, "done", null);
}

function failCard(jobId: string, cardId: string, error: string): void {
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE cards SET status = 'draft', push_error = ?, updated_at = ? WHERE id = ?").run(error, Date.now(), cardId);
    sqlite.prepare("UPDATE push_jobs SET failed = failed + 1, updated_at = ? WHERE id = ?").run(Date.now(), jobId);
  })();
}

function markPushed(jobId: string, card: CardRow, deckId: string, chapterId: string, markjiCardId: string): void {
  const now = Date.now();
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE cards SET status = 'pushed', push_error = NULL, markji_deck_id = ?, markji_chapter_id = ?,
           markji_card_id = ?, pushed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(deckId, chapterId, markjiCardId, now, now, card.id);
    // exports 的唯一键是 (词, 目标, 牌组, 卡型)，一个词多张卡就用卡 id 区分卡型
    sqlite
      .prepare(
        `INSERT INTO exports (id, user_word_id, target, deck_id, chapter_id, card_id, card_type, status, error, pushed_at)
         VALUES (?, ?, 'markji', ?, ?, ?, ?, 'done', NULL, ?)
         ON CONFLICT(user_word_id, target, deck_id, card_type) DO UPDATE SET
           chapter_id = excluded.chapter_id, card_id = excluded.card_id, status = 'done', error = NULL, pushed_at = excluded.pushed_at`,
      )
      .run(randomUUID(), card.user_word_id, deckId, chapterId, markjiCardId, `exam:${card.id}`, now);
    sqlite.prepare("UPDATE push_jobs SET done = done + 1, updated_at = ? WHERE id = ?").run(now, jobId);
  })();
}

// ---------- 墨墨请求：限速 + 重试 + 防重复 ----------

const retriable = (err: unknown): boolean =>
  !(err instanceof MarkjiError) || err.status === 429 || err.status >= 500;

/** 读请求 / 建章节：限速后执行，429 / 5xx / 网络错误按 5s、10s、20s 重试 */
async function withRetry<T>(userId: string, deps: Deps, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await paced(userId, deps, fn);
    } catch (err) {
      if (!retriable(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await deps.sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function createWithRetry(
  userId: string, deps: Deps, deckId: string, chapterId: string, content: string, token: string,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await paced(userId, deps, () => createCard(deckId, chapterId, content, token))).id;
    } catch (err) {
      if (!retriable(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await deps.sleep(RETRY_DELAYS_MS[attempt]);
      // 429 说明请求没被处理；5xx / 超时可能已经建成功，重试前先认领，避免建出重复卡
      if (!(err instanceof MarkjiError && err.status === 429)) {
        const claimed = await findExisting(userId, deps, deckId, chapterId, content, token).catch(() => null);
        if (claimed) return claimed;
      }
    }
  }
}

/**
 * 在章节里找一张「内容和这张草稿完全一样、又不属于任何已推送记录」的卡。
 * 只看章节末尾 CLAIM_SCAN 张未认领的卡（新建的卡追加在末尾）。
 */
async function findExisting(
  userId: string, deps: Deps, deckId: string, chapterId: string, content: string, token: string,
): Promise<string | null> {
  const chapters = await withRetry(userId, deps, () => listChapters(deckId, token, { withCards: true }));
  const ids = chapters.find((c) => c.id === chapterId)?.card_ids ?? [];
  if (ids.length === 0) return null;
  const known = new Set(
    (sqlite.prepare("SELECT markji_card_id AS id FROM cards WHERE user_id = ? AND markji_card_id IS NOT NULL").all(userId) as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const candidates = ids.filter((x) => !known.has(x)).slice(-CLAIM_SCAN);
  for (const cid of candidates.reverse()) {
    const c = await withRetry(userId, deps, () => getCard(deckId, cid, token));
    if (c.content.trim() === content.trim()) return c.id;
  }
  return null;
}

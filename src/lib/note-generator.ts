/**
 * P32 F3：老师笔记（AI 记忆）的后台生成。
 *
 * 硬约束（PRD F3 / 实现说明 §5.6 / §10.5）：
 * - 绝不 await 在用户请求里：本模块对外只暴露一个返回 void 的入口。
 * - 同一个用户在同一进程里同时最多只跑一个（模块级 Set）。
 * - 用站点配置的模型：allSettings() 不带 userId，只读站级行，不会碰用户自己的 Key。
 * - 不调用 consumeAiQuota：更新笔记不占用户每天免费的 AI 次数。
 * - 站点没配模型时直接返回，不生成、也不写错误。
 * - 校验失败 / 出错只记日志和 note_last_error，游标不动。
 *
 * P32-修复（失败冷却）：成功路径由 shouldUpdateNote 的 25 次查词 + 24 小时约束，
 * 但它只认「上次成功更新」的游标。失败时游标不动，所以每次满足条件的讲解都会重试模型。
 * 这里再加一道闸门：失败后至少 1 小时不再尝试、每个用户每天最多尝试 3 次（成功与否都算）。
 * 状态放进程内存（Map），与已有的 running Set 同生命周期：不需要加列/迁移，
 * 不增加失败时的 DB 写入，重启清空可接受；落库的游标与时间才是权威的成功节奏。
 */
import { allSettings } from "./settings-store";
import { resolveProvider } from "./config";
import { completeChat } from "./providers";
import {
  getLearner,
  lookupCountSince,
  notePromptInputFor,
  recordNoteError,
  saveNote,
} from "./learner-store";
import { buildNotePrompt, shouldUpdateNote, validateNote } from "./learner/note";
import { noteBlockReason, settleNoteAttempt, type NoteAttemptState } from "./learner/note-throttle";

/** 同一时刻每个用户只允许一个生成任务 */
const running = new Set<string>();

/**
 * 每个用户的尝试状态（当日次数 + 最近失败时间）。
 * 只活在进程内存里：服务重启后清空，用户最多再得到 3 次尝试；这是可接受的取舍，
 * 因为它是防「同一个进程内反复打模型」的保险丝，权威的成功节奏仍是落库的游标与时间。
 */
const attempts = new Map<string, NoteAttemptState>();

/** 供单测/诊断读取当前并发数，不参与业务判断 */
export function runningNoteJobs(): number {
  return running.size;
}

/**
 * 在后台尝试更新笔记。调用方一律 `void maybeUpdateNote(userId)`。
 * 任何失败都被吞在这里，不会冒泡到讲解请求。
 */
export function maybeUpdateNote(userId: string): void {
  if (running.has(userId)) return;
  running.add(userId);
  void (async () => {
    try {
      await generateNote(userId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "老师笔记生成失败";
      console.error("[learner] 老师笔记生成失败:", reason);
      try {
        recordNoteError(userId, reason);
      } catch {
        /* 连错误都记不下时也不抛，绝不影响查词 */
      }
    } finally {
      running.delete(userId);
    }
  })();
}

async function generateNote(userId: string): Promise<void> {
  const row = getLearner(userId);
  // 清空记忆之后累计的查词数；cursor 是上次成功生成时的总数
  const lookupsTotal = lookupCountSince(userId, row.memory_reset_at);
  if (
    !shouldUpdateNote({
      lookupsTotal,
      cursor: row.note_lookup_cursor,
      updatedAt: row.note_updated_at,
      now: Date.now(),
    })
  ) {
    return;
  }

  // 站点没配模型：直接返回，不生成。GET /api/learner 会返回 no_model 说明原因。
  const provider = resolveProvider(allSettings(), process.env);
  if (!provider) return;

  // 失败冷却 / 每日上限：只挡「准备调用模型」这一步。
  // 不满足 shouldUpdateNote、站点没模型都不算一次尝试，也不会消耗配额。
  if (noteBlockReason(attempts.get(userId) ?? null, Date.now())) return;

  let succeeded = false;
  try {
    const prompt = buildNotePrompt(notePromptInputFor(userId));
    const raw = await completeChat(
      provider,
      [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      { temperature: 0.3, maxTokens: 400 },
    );

    const v = validateNote(raw);
    if (!v.ok) {
      console.error("[learner] 老师笔记校验失败:", v.reason);
      recordNoteError(userId, v.reason); // 游标不动；冷却由 finally 写入
      return;
    }
    saveNote(userId, v.note, lookupsTotal);
    succeeded = true;
  } finally {
    // 成功、校验失败、模型抛错 / 60 秒超时，都算一次尝试；失败写入 1 小时冷却起点。
    const state = attempts.get(userId) ?? null;
    attempts.set(userId, settleNoteAttempt(state, { success: succeeded, now: Date.now() }));
  }
}

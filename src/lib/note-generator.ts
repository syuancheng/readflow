/**
 * 老师笔记（AI 记忆）的生成（P32 F3，P34 改为每晚整理）。
 *
 * 硬约束：
 * - 由每晚整理（lib/nightly-note.ts）调用，绝不在用户请求里 await。
 * - 同一个用户在同一进程里同时最多只跑一个（模块级 Set）。
 * - 用站点配置的模型：allSettings() 不带 userId，只读站级行，不会碰用户自己的 Key。
 * - 不调用 consumeAiQuota：更新笔记不占用户每天免费的 AI 次数。
 * - 站点没配模型时直接返回，不生成、也不写错误。
 * - 校验失败 / 出错只记日志和 note_last_error。
 * - 失败冷却：失败后至少 1 小时不再尝试、每个用户每天最多尝试 3 次（learner/note-throttle.ts）。
 */
import { allSettings } from "./settings-store";
import { resolveProvider } from "./config";
import { completeChat } from "./providers";
import { answeredFeedbackFor, notePromptInputFor, recordNoteError, saveNote } from "./learner-store";
import { validateNote } from "./learner/note";
import { buildNightlyNotePrompt } from "./learner/nightly";
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

export type NoteRunResult = "ok" | "skipped" | "failed";

/**
 * 立即为一个用户整理一次老师笔记（每晚整理逐个用户调用，按顺序 await）。
 * 任何失败都被吞在这里并记 note_last_error，不会抛出。
 */
export async function generateNoteNow(userId: string): Promise<NoteRunResult> {
  if (running.has(userId)) return "skipped";
  running.add(userId);
  try {
    return await generateNote(userId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "老师笔记生成失败";
    console.error("[learner] 老师笔记生成失败:", reason);
    try {
      recordNoteError(userId, reason);
    } catch {
      /* 连错误都记不下时也不抛 */
    }
    return "failed";
  } finally {
    running.delete(userId);
  }
}

async function generateNote(userId: string): Promise<NoteRunResult> {
  // 站点没配模型：直接返回，不生成。GET /api/learner 会返回 no_model 说明原因。
  const provider = resolveProvider(allSettings(), process.env);
  if (!provider) return "skipped";

  // 失败冷却 / 每日上限：只挡「准备调用模型」这一步。
  if (noteBlockReason(attempts.get(userId) ?? null, Date.now())) return "skipped";

  let succeeded = false;
  try {
    const prompt = buildNightlyNotePrompt({ ...notePromptInputFor(userId), answered: answeredFeedbackFor(userId) });
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
      recordNoteError(userId, v.reason);
      return "failed";
    }
    saveNote(userId, v.note, "nightly");
    succeeded = true;
    return "ok";
  } finally {
    // 成功、校验失败、模型抛错 / 60 秒超时，都算一次尝试；失败写入 1 小时冷却起点。
    const state = attempts.get(userId) ?? null;
    attempts.set(userId, settleNoteAttempt(state, { success: succeeded, now: Date.now() }));
  }
}

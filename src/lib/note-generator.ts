/**
 * P32 F3：老师笔记（AI 记忆）的后台生成。
 *
 * 硬约束（PRD F3 / 实现说明 §5.6 / §10.5）：
 * - 绝不 await 在用户请求里：本模块对外只暴露一个返回 void 的入口。
 * - 同一个用户在同一进程里同时最多只跑一个（模块级 Set）。
 * - 用站点配置的模型：allSettings() 不带 userId，只读站级行，不会碰用户自己的 Key。
 * - 不调用 consumeAiQuota：更新笔记不占用户每天免费的 AI 次数。
 * - 站点没配模型时直接返回，不生成、也不写错误。
 * - 校验失败 / 出错只记日志和 note_last_error，游标不动，下次满足条件自动重试。
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

/** 同一时刻每个用户只允许一个生成任务 */
const running = new Set<string>();

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
    recordNoteError(userId, v.reason); // 游标不动，下次自动重试
    return;
  }
  saveNote(userId, v.note, lookupsTotal);
}

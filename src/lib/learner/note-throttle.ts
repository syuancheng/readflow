/**
 * P32-修复：老师笔记的「失败冷却」与「每日尝试上限」纯函数。
 *
 * 背景：shouldUpdateNote 只看「上次成功更新」的游标和时间。一旦生成失败，游标不动，
 * 每一次满足条件的讲解都会重新调用模型 —— 假模型持续返回不合格笔记时会形成重试风暴。
 * 因此成功路径继续由 shouldUpdateNote（25 次查词 + 24 小时）约束，失败路径另由本模块约束：
 * - 任何一次失败（校验不过 / 模型异常 / 60 秒超时）后至少 1 小时不再尝试；
 * - 每个用户每天最多尝试 3 次，成功与否都算。
 *
 * 状态由 note-generator.ts 存在进程内存里；这里只做判断与状态转移，不碰数据库、不发请求，
 * 因此「连续 8 次请求会不会把模型打 8 次」可以直接在单测里复现。
 * 单测把本目录编译成 CommonJS 直接运行，这里只能用相对路径 import。
 */

/** 失败后至少 1 小时再尝试 */
export const NOTE_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
/** 每个用户每天最多尝试 3 次（成功与否都算） */
export const NOTE_MAX_ATTEMPTS_PER_DAY = 3;

export type NoteAttemptState = {
  /** 本机本地日期 YYYY-MM-DD；日期变化即清零当日次数 */
  dayKey: string;
  /** 当日已发起的模型调用次数 */
  attempts: number;
  /** 最近一次失败的时间戳；从未失败为 null */
  lastFailureAt: number | null;
};

export type NoteBlockReason = "failure_cooldown" | "daily_limit";

/** 用本机本地日期算「每天」，与 ai-quota 的口径无关、也不依赖 UTC 零点 */
export function noteDayKey(now: number): string {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 能不能发起一次模型调用。
 * 失败冷却按绝对时间算，跨天也不会解除；当日上限只在同一个日期键内生效。
 */
export function noteBlockReason(
  state: NoteAttemptState | null,
  now: number,
): NoteBlockReason | null {
  if (!state) return null;
  if (state.lastFailureAt !== null && now - state.lastFailureAt < NOTE_FAILURE_COOLDOWN_MS) {
    return "failure_cooldown";
  }
  if (state.dayKey === noteDayKey(now) && state.attempts >= NOTE_MAX_ATTEMPTS_PER_DAY) {
    return "daily_limit";
  }
  return null;
}

export function canAttemptNote(state: NoteAttemptState | null, now: number): boolean {
  return noteBlockReason(state, now) === null;
}

/**
 * 结算一次「已经发起的模型调用」：成功与否都计入当日次数；失败把当前时间写成冷却起点。
 * 成功会清掉冷却起点（能成功说明早已过了冷却窗口），并把次数留在同一天里继续累计。
 */
export function settleNoteAttempt(
  state: NoteAttemptState | null,
  result: { success: boolean; now: number },
): NoteAttemptState {
  const dayKey = noteDayKey(result.now);
  const attempts = state && state.dayKey === dayKey ? state.attempts + 1 : 1;
  return {
    dayKey,
    attempts,
    lastFailureAt: result.success ? null : result.now,
  };
}

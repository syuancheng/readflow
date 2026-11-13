import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_FAILURE_COOLDOWN_MS,
  NOTE_MAX_ATTEMPTS_PER_DAY,
  canAttemptNote,
  noteBlockReason,
  noteDayKey,
  settleNoteAttempt,
  type NoteAttemptState,
} from "../../src/lib/learner/note-throttle";
import { NOTE_MIN_INTERVAL_MS, shouldUpdateNote } from "../../src/lib/learner/note";

// 用本机本地中午做基准，保证「每隔 1 小时发 8 次」仍落在同一天里
const NOON = new Date(2026, 10, 13, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const state = (over: Partial<NoteAttemptState> = {}): NoteAttemptState => ({
  dayKey: noteDayKey(NOON),
  attempts: 1,
  lastFailureAt: null,
  ...over,
});

test("P32-修复 阈值：失败冷却 1 小时、每天最多尝试 3 次", () => {
  assert.equal(NOTE_FAILURE_COOLDOWN_MS, HOUR);
  assert.equal(NOTE_MAX_ATTEMPTS_PER_DAY, 3);
  assert.equal(NOTE_MIN_INTERVAL_MS, 24 * HOUR, "成功路径的 24 小时间隔保持不变");
});

test("P32-修复 noteDayKey：用本机本地日期，跨天换键", () => {
  assert.equal(noteDayKey(NOON), "2026-11-13");
  assert.equal(noteDayKey(NOON + 24 * HOUR), "2026-11-14");
});

test("P32-修复 从未尝试过：允许第一次调用模型", () => {
  assert.equal(noteBlockReason(null, NOON), null);
  assert.equal(canAttemptNote(null, NOON), true);
});

test("P32-修复 失败后 1 小时内一律挡住（失败冷却）", () => {
  const s = settleNoteAttempt(null, { success: false, now: NOON });
  assert.equal(noteBlockReason(s, NOON + 1), "failure_cooldown");
  assert.equal(noteBlockReason(s, NOON + HOUR - 1), "failure_cooldown");
  assert.equal(canAttemptNote(s, NOON + HOUR - 1), false);
});

test("P32-修复 正好满 1 小时才放行（边界包含）", () => {
  const s = settleNoteAttempt(null, { success: false, now: NOON });
  assert.equal(noteBlockReason(s, NOON + HOUR), null);
  assert.equal(canAttemptNote(s, NOON + HOUR), true);
});

test("P32-修复 冷却按绝对时间算，跨天也不提前解除", () => {
  const s: NoteAttemptState = {
    dayKey: "2026-11-12",
    attempts: 1,
    lastFailureAt: NOON - 10 * 60 * 1000,
  };
  assert.equal(noteBlockReason(s, NOON), "failure_cooldown");
});

test("P32-修复 成功也计入当日次数：3 次成功后第 4 次被挡", () => {
  let s = settleNoteAttempt(null, { success: true, now: NOON });
  s = settleNoteAttempt(s, { success: true, now: NOON + HOUR });
  s = settleNoteAttempt(s, { success: true, now: NOON + 2 * HOUR });
  assert.equal(s.attempts, 3);
  assert.equal(noteBlockReason(s, NOON + 3 * HOUR), "daily_limit");
  assert.equal(canAttemptNote(s, NOON + 3 * HOUR), false);
});

test("P32-修复 成功会清掉旧的冷却起点，失败会重写冷却起点", () => {
  const failed = settleNoteAttempt(null, { success: false, now: NOON });
  assert.equal(failed.lastFailureAt, NOON);
  const ok = settleNoteAttempt(failed, { success: true, now: NOON + HOUR });
  assert.equal(ok.lastFailureAt, null);
  assert.equal(ok.attempts, 2);
  const failedAgain = settleNoteAttempt(ok, { success: false, now: NOON + 2 * HOUR });
  assert.equal(failedAgain.lastFailureAt, NOON + 2 * HOUR);
  assert.equal(failedAgain.attempts, 3);
});

test("P32-修复 跨天清零当日次数，但次数重新开始累计", () => {
  const yesterday: NoteAttemptState = {
    dayKey: "2026-11-12",
    attempts: 3,
    lastFailureAt: null,
  };
  assert.equal(noteBlockReason(yesterday, NOON), null, "新的一天可以重新尝试");
  const s = settleNoteAttempt(yesterday, { success: false, now: NOON });
  assert.equal(s.attempts, 1);
  assert.equal(s.dayKey, noteDayKey(NOON));
  assert.equal(s.lastFailureAt, NOON);
});

test("P32-修复 冷却与每日上限同时具备时优先报冷却", () => {
  const s: NoteAttemptState = {
    dayKey: noteDayKey(NOON),
    attempts: 5,
    lastFailureAt: NOON - 1000,
  };
  assert.equal(noteBlockReason(s, NOON), "failure_cooldown");
});

/**
 * 复现用户报的重试风暴：shouldUpdateNote 在失败后仍然为真（游标不动），
 * 假模型一直返回不合格笔记。这里按 note-generator.ts 的真实顺序走一遍：
 * shouldUpdateNote → 冷却闸门 → 调模型 → 结算（失败不推进游标）。
 */
function simulateRequests(stepMs: number): { calls: number; cursor: number; endState: NoteAttemptState | null } {
  const lookupsTotal = 30; // 满足 25 次新增查词
  let cursor = 0;
  let updatedAt: number | null = null;
  let throttle: NoteAttemptState | null = null;
  let calls = 0;
  const fakeBadNoteModel = (): boolean => false; // 永远不合格

  for (let i = 0; i < 8; i++) {
    const now = NOON + i * stepMs;
    if (!shouldUpdateNote({ lookupsTotal, cursor, updatedAt, now })) continue;
    if (!canAttemptNote(throttle, now)) continue;
    calls++;
    const success = fakeBadNoteModel();
    throttle = settleNoteAttempt(throttle, { success, now });
    if (success) {
      cursor = lookupsTotal;
      updatedAt = now;
    }
  }
  return { calls, cursor, endState: throttle };
}

test("P32-修复 重试风暴：连续 8 次满足条件的讲解只调用模型 1 次", () => {
  // 先确认根因确实存在：失败时游标不动，第 8 次仍满足 shouldUpdateNote
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 30, cursor: 0, updatedAt: null, now: NOON + 7 * 1000 }),
    true,
    "失败后游标不动，shouldUpdateNote 仍为真 —— 这正是需要冷却的原因",
  );
  const r = simulateRequests(1000);
  assert.equal(r.calls, 1, `没有冷却时会被调用 8 次，实际 ${r.calls} 次`);
  assert.equal(r.cursor, 0, "失败不推进游标");
  assert.equal(r.endState?.attempts, 1);
  assert.equal(r.endState?.lastFailureAt, NOON);
});

test("P32-修复 重试风暴：请求间隔超过 1 小时时，8 次也最多调用 3 次（每日上限）", () => {
  const r = simulateRequests(HOUR + 1);
  assert.equal(r.calls, 3, `每日上限 3 次，实际 ${r.calls} 次`);
  assert.equal(r.cursor, 0);
  assert.equal(r.endState?.attempts, 3);
});

test("P32-修复 成功路径不受影响：25 次 + 24 小时仍由 shouldUpdateNote 决定", () => {
  assert.equal(shouldUpdateNote({ lookupsTotal: 25, cursor: 0, updatedAt: null, now: NOON }), true);
  assert.equal(shouldUpdateNote({ lookupsTotal: 24, cursor: 0, updatedAt: null, now: NOON }), false);
  assert.equal(
    shouldUpdateNote({ lookupsTotal: 50, cursor: 25, updatedAt: NOON - 24 * HOUR + 1, now: NOON }),
    false,
  );
});

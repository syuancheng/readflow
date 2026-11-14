/**
 * P34 F3 / F6：每晚整理老师笔记 + 过期删除。
 *
 * - src/instrumentation.ts 在服务启动时调用 startNightlyScheduler()。
 * - 启动后立即检查一次，之后每 10 分钟检查一次；北京时间过了 3 点且今天还没跑过就跑
 *   （也覆盖「凌晨没开机、启动后补做」）。跑完把日期写进站级设置 learner.nightlyRunDay。
 * - 一次运行：先删过期记录，再逐个用户（串行、间隔 2 秒）整理新动静攒够 10 次的用户。
 * - 单个用户失败只记该用户的 note_last_error，不影响其他人。
 */
import { sqlite } from "@/db/sqlite";
import { GLOBAL_USER } from "@/db/ensure-auth";
import { getSetting, setSetting } from "@/lib/settings-store";
import { getProfileForPrompt, newEventsSinceNote, purgeExpiredEvents } from "@/lib/learner-store";
import { generateNoteNow } from "@/lib/note-generator";
import { NIGHTLY_HOUR, nightlyDue, nightlyEligible, retentionCutoffs, shanghaiDay } from "@/lib/learner/nightly";

export const NIGHTLY_RUN_DAY_KEY = "learner.nightlyRunDay";
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const USER_GAP_MS = 2000;

const g = globalThis as unknown as { __rfNightly?: { timer: ReturnType<typeof setInterval>; busy: boolean } };

function envNumber(name: string): number | null {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(n) ? n : null;
}

/** 启动调度器（进程内只启动一个，防开发模式热重载重复启动） */
export function startNightlyScheduler(): void {
  if (g.__rfNightly) return;
  const interval = envNumber("READFLOW_NIGHTLY_INTERVAL_MS") ?? DEFAULT_INTERVAL_MS;
  const state = { timer: setInterval(() => void tick(), interval), busy: false };
  state.timer.unref?.();
  g.__rfNightly = state;
  void tick();
}

async function tick(): Promise<void> {
  const state = g.__rfNightly;
  if (!state || state.busy) return;
  const hour = envNumber("READFLOW_NIGHTLY_HOUR") ?? NIGHTLY_HOUR;
  const now = Date.now();
  if (!nightlyDue(now, getSetting(NIGHTLY_RUN_DAY_KEY, GLOBAL_USER), hour)) return;
  state.busy = true;
  try {
    await runNightlyOnce(now);
  } catch (err) {
    console.error("[nightly] 每晚整理出错:", err);
  } finally {
    state.busy = false;
  }
}

/** 跑一次：过期删除 → 逐个用户整理 → 记下今天已跑过 */
export async function runNightlyOnce(now: number = Date.now()): Promise<{ purged: ReturnType<typeof purgeExpiredEvents>; ran: string[] }> {
  const purged = purgeExpiredEvents(retentionCutoffs(now));
  console.log(`[nightly] 过期删除：讲解 ${purged.explain} 条、查词 ${purged.lookup} 条、回答原文 ${purged.answers} 条`);

  const users = sqlite.prepare("SELECT id FROM users ORDER BY created_at").all() as { id: string }[];
  const ran: string[] = [];
  for (const u of users) {
    let eligible = false;
    try {
      eligible = nightlyEligible({ personalized: getProfileForPrompt(u.id).personalized, newEvents: newEventsSinceNote(u.id) });
    } catch (err) {
      console.error("[nightly] 判断是否整理失败:", u.id, err);
    }
    if (!eligible) continue;
    if (ran.length > 0) await new Promise((r) => setTimeout(r, USER_GAP_MS));
    const result = await generateNoteNow(u.id);
    if (result === "ok") ran.push(u.id);
  }
  setSetting(NIGHTLY_RUN_DAY_KEY, shanghaiDay(now), GLOBAL_USER);
  console.log(`[nightly] 整理完成：${ran.length} 位用户的老师笔记已更新`);
  return { purged, ran };
}

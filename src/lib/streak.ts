/**
 * 学习日历与连续天数的纯计算。没有 IO、没有依赖，服务端和测试脚本都能直接引。
 *
 * 从 stats.ts 拆出来是因为这块逻辑边界最容易错（今天还没收词算不算断档、
 * 跨月跨年、夏令时那天的 23/25 小时），而 stats.ts 一 import 就会连数据库，
 * 没法在脚本里干净地测。
 */

export type CalendarCell = {
  date: string;
  count: number;
  /** 0 = 周一 … 6 = 周日，画热力图时用它决定行号 */
  weekday: number;
  /** 本周还没到的日子，格子留空 */
  future: boolean;
};

export type StreakResult = {
  /** 当前连续天数 */
  streakDays: number;
  /** 历史最长连续天数 */
  bestStreak: number;
  /** 有过收词的总天数 */
  activeDays: number;
};

/** 本地时区的 YYYY-MM-DD。不能用 toISOString()，那会按 UTC 算，差一天。 */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseKey(k: string): Date {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 相差几天。用 round 是为了跨夏令时那一天实际只有 23 或 25 小时。 */
export function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * 按周对齐铺格子：起始日是本周一往前推 (weeks - 1) 周。
 *
 * 不按「最近 N 天」滑窗，而是铺满 weeks×7 —— 这样热力图的列边界永远是整周，
 * 月份标签也好对齐。最后一列可能有还没到的日子，那些格子 future = true。
 */
export function buildCalendar(
  byDay: Map<string, number>,
  weeks: number,
  today: Date,
): CalendarCell[] {
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((today.getDay() + 6) % 7)); // 周日=0 → 周一=0

  const cursor = new Date(monday);
  cursor.setDate(cursor.getDate() - (weeks - 1) * 7);

  const cells: CalendarCell[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      cells.push({
        date: dayKey(cursor),
        count: byDay.get(dayKey(cursor)) ?? 0,
        weekday: d,
        future: cursor.getTime() > today.getTime(),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return cells;
}

/**
 * 连续天数。两个容易做错的地方：
 *
 * 1. **今天还没收词不算断档。** 一天没过完就判 streak 归零的话，用户早上打开
 *    会看到 0，很打击人。所以今天为 0 时从昨天开始往前数。
 * 2. **bestStreak 走全量历史**，不依赖柱状图那个 N 天窗口 —— 否则连续记录
 *    超过窗口长度就会被截断。
 */
export function computeStreaks(
  byDay: Map<string, number>,
  today: Date,
): StreakResult {
  const active = [...byDay.entries()]
    .filter(([, c]) => c > 0)
    .map(([k]) => parseKey(k))
    .sort((a, b) => a.getTime() - b.getTime());

  if (active.length === 0) {
    return { streakDays: 0, bestStreak: 0, activeDays: 0 };
  }

  // 当前 streak
  const cursor = new Date(today);
  cursor.setHours(0, 0, 0, 0);
  if ((byDay.get(dayKey(cursor)) ?? 0) === 0) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streakDays = 0;
  while ((byDay.get(dayKey(cursor)) ?? 0) > 0) {
    streakDays++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // 历史最长
  let bestStreak = 1;
  let run = 1;
  for (let i = 1; i < active.length; i++) {
    run = diffDays(active[i], active[i - 1]) === 1 ? run + 1 : 1;
    if (run > bestStreak) bestStreak = run;
  }

  return { streakDays, bestStreak, activeDays: active.length };
}

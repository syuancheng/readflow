/**
 * 学习日历 / 连续天数的回归脚本。
 *
 *   npm run verify:stats
 *
 * 为什么单独测这块：连续天数的边界很容易错，而且错了不会崩、只会显示错的数字
 * —— 用户看不出 3 和 4 哪个对，但错的那个会一直错下去。
 * 日历那部分要验的是「列边界永远是整周」，滑窗写法在这里会露馅。
 */
import { buildCalendar, computeStreaks, dayKey, diffDays } from "../src/lib/streak";

let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(
    `  ${ok ? "✅" : "❌"} ${name}` +
      (ok ? "" : `\n       期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`),
  );
}

/** 相对 today 偏移 n 天的 key */
function keyAt(today: Date, offset: number): string {
  const d = new Date(today);
  d.setDate(d.getDate() + offset);
  return dayKey(d);
}

const TODAY = new Date(2026, 10, 3); // 2026-11-03，周二，固定住避免跑测试时结果漂移

console.log("\n【连续天数】");

// 今天收了词
check(
  "只有今天 → streak 1",
  computeStreaks(new Map([[keyAt(TODAY, 0), 3]]), TODAY),
  { streakDays: 1, bestStreak: 1, activeDays: 1 },
);

// 今天还没收，但昨天收了 —— 不该判成 0
check(
  "今天没收、昨天收 → streak 1（今天不算断档）",
  computeStreaks(new Map([[keyAt(TODAY, -1), 2]]), TODAY),
  { streakDays: 1, bestStreak: 1, activeDays: 1 },
);

// 连续三天，含今天
check(
  "昨天+今天+前天 → streak 3",
  computeStreaks(
    new Map([
      [keyAt(TODAY, 0), 1],
      [keyAt(TODAY, -1), 1],
      [keyAt(TODAY, -2), 1],
    ]),
    TODAY,
  ),
  { streakDays: 3, bestStreak: 3, activeDays: 3 },
);

// 断档：只有前天，昨天空
check(
  "前天有、昨天空 → streak 0",
  computeStreaks(new Map([[keyAt(TODAY, -2), 1]]), TODAY),
  { streakDays: 0, bestStreak: 1, activeDays: 1 },
);

// 最长连续在历史上，当前已断
check(
  "历史连续 4 天但已断 → streak 0 / best 4",
  computeStreaks(
    new Map([
      [keyAt(TODAY, -10), 1],
      [keyAt(TODAY, -9), 1],
      [keyAt(TODAY, -8), 1],
      [keyAt(TODAY, -7), 1],
    ]),
    TODAY,
  ),
  { streakDays: 0, bestStreak: 4, activeDays: 4 },
);

// 两段连续，取长的一段
check(
  "两段连续（3 天 + 5 天）→ best 5",
  computeStreaks(
    new Map([
      [keyAt(TODAY, -20), 1],
      [keyAt(TODAY, -19), 1],
      [keyAt(TODAY, -18), 1],
      [keyAt(TODAY, -5), 1],
      [keyAt(TODAY, -4), 1],
      [keyAt(TODAY, -3), 1],
      [keyAt(TODAY, -2), 1],
      [keyAt(TODAY, -1), 1],
    ]),
    TODAY,
  ),
  { streakDays: 5, bestStreak: 5, activeDays: 8 },
);

// 跨月（10/31 → 11/01 必须算连续）
{
  const today = new Date(2026, 10, 1);
  const m = new Map([
    ["2026-10-31", 1],
    ["2026-11-01", 1],
  ]);
  check("跨月 10/31 + 11/01 → streak 2", computeStreaks(m, today), {
    streakDays: 2,
    bestStreak: 2,
    activeDays: 2,
  });
}

// 跨年（12/31 → 01/01）
{
  const today = new Date(2027, 0, 1);
  const m = new Map([
    ["2026-12-31", 1],
    ["2027-01-01", 1],
  ]);
  check("跨年 12/31 + 01/01 → streak 2", computeStreaks(m, today), {
    streakDays: 2,
    bestStreak: 2,
    activeDays: 2,
  });
}

check("全空 → 全 0", computeStreaks(new Map(), TODAY), {
  streakDays: 0,
  bestStreak: 0,
  activeDays: 0,
});

console.log("\n【日历网格】");

{
  const cells = buildCalendar(new Map(), 18, TODAY);
  check("18 周 → 126 格", cells.length, 126);
  check("第一格是周一", cells[0].weekday, 0);
  check("最后一格是周日", cells[cells.length - 1].weekday, 6);

  // 列边界必须是整周：第 0 格与第 7 格的 weekday 应相同
  check("第 8 格又是周一（列边界对齐）", cells[7].weekday, 0);

  // 最后一格是本周周日（未来），今天(周二)之后的都是 future
  const futureCount = cells.filter((c) => c.future).length;
  check("未来格子数 = 周二起还剩 5 天", futureCount, 5);

  const todayCell = cells.find((c) => c.date === dayKey(TODAY));
  check("今天不是 future", todayCell?.future, false);
}

{
  // 铺格子必须覆盖到今天，否则热力图右下角会缺一块
  const cells = buildCalendar(new Map([[keyAt(TODAY, 0), 5]]), 18, TODAY);
  const hit = cells.filter((c) => c.count > 0);
  check("今天的收词能落进格子", hit.length, 1);
  check("格子里的数量正确", hit[0]?.count, 5);
}

console.log("\n【日期工具】");
check("diffDays 相邻 1 天", diffDays(new Date(2026, 10, 3), new Date(2026, 10, 2)), 1);
check("dayKey 本地日期（不是 UTC）", dayKey(new Date(2026, 10, 3, 23, 59)), "2026-11-03");

console.log(
  failed === 0 ? "\n全部通过 ✅\n" : `\n${failed} 项失败 ❌\n`,
);
process.exit(failed === 0 ? 0 : 1);

"use client";

import { formatMinutes } from "@/lib/listening";
import type { CalendarCell } from "@/lib/streak";

/**
 * GitHub 贡献图式的学习日历。列 = 周，行 = 星期（周一起）。
 *
 * 阅读与听力共用同一组件：通过 thresholds 与 unitLabel 区分分档与悬停文案。
 */

const LEVEL_BG = [
  "var(--rf-heat-0)",
  "var(--rf-heat-1)",
  "var(--rf-heat-2)",
  "var(--rf-heat-3)",
  "var(--rf-heat-4)",
];

/** 默认阅读词数分档：0 / <500 / 500–1499 / 1500–2999 / ≥3000 */
export const READING_HEAT_THRESHOLDS: readonly [number, number, number] = [500, 1500, 3000];
/** 听力分钟分档：0 / <10 / 10–29 / 30–59 / ≥60 */
export const LISTENING_HEAT_THRESHOLDS: readonly [number, number, number] = [10, 30, 60];

function level(count: number, thresholds: readonly [number, number, number]): number {
  if (count <= 0) return 0;
  if (count < thresholds[0]) return 1;
  if (count < thresholds[1]) return 2;
  if (count < thresholds[2]) return 3;
  return 4;
}

const WEEKDAY_LABEL = ["一", "", "三", "", "五", "", ""];

export default function HeatCalendar({
  cells,
  thresholds = READING_HEAT_THRESHOLDS,
  unitLabel = "词",
}: {
  cells: CalendarCell[];
  thresholds?: readonly [number, number, number];
  unitLabel?: string;
}) {
  if (cells.length === 0) return null;

  // 按周切开，每列 7 格
  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  // 每月第一次出现的那一列打标签
  const monthLabels = weeks.map((week, wi) => {
    const month = Number(week[0].date.slice(5, 7));
    const prev = wi > 0 ? Number(weeks[wi - 1][0].date.slice(5, 7)) : -1;
    return month !== prev ? `${month}月` : "";
  });

  return (
    <div className="flex gap-2">
      {/* 星期 */}
      <div
        className="grid grid-rows-7 gap-1 text-xs font-bold text-ink-faint pt-px"
        style={{ width: 16 }}
      >
        {WEEKDAY_LABEL.map((label, i) => (
          <div key={i} className="h-[12px] leading-[12px]">
            {label}
          </div>
        ))}
      </div>

      <div className="overflow-x-auto">
        <div className="flex gap-1">
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-rows-7 gap-1">
              {week.map((cell) => (
                <div
                  key={cell.date}
                  title={
                    cell.future
                      ? undefined
                      : `${cell.date} · ${formatMinutes(cell.count)} ${unitLabel}`
                  }
                  className="w-[12px] h-[12px] rounded-xs"
                  style={{
                    background: cell.future
                      ? "transparent"
                      : LEVEL_BG[level(cell.count, thresholds)],
                  }}
                />
              ))}
            </div>
          ))}
        </div>

        {/* 月份 */}
        <div className="flex gap-1 mt-2">
          {monthLabels.map((label, i) => (
            <div
              key={i}
              className="text-xs font-bold text-ink-faint whitespace-nowrap"
              style={{ width: 12 }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 图例：少 → 多 */
export function HeatLegend() {
  return (
    <div className="flex items-center gap-2 text-xs font-bold text-ink-faint">
      <span>少</span>
      {LEVEL_BG.map((bg, i) => (
        <div
          key={i}
          className="w-[12px] h-[12px] rounded-xs"
          style={{ background: bg }}
        />
      ))}
      <span>多</span>
    </div>
  );
}

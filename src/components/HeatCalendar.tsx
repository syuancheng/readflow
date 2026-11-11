"use client";

import type { CalendarCell } from "@/lib/streak";

/**
 * GitHub 贡献图式的学习日历。列 = 周，行 = 星期（周一起）。
 *
 * 纯展示组件，但标了 "use client" —— 因为格子带 title 悬浮提示，
 * 而且战绩页将来可能加「点某天看当天收的词」，留着交互入口。
 */

const LEVEL_BG = [
  "var(--heat-0)",
  "var(--heat-1)",
  "var(--heat-2)",
  "var(--heat-3)",
  "var(--heat-4)",
];

/** 分档阈值是拍的：一天收 1–2 个是常态，10 个以上算高产 */
function level(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

const WEEKDAY_LABEL = ["一", "", "三", "", "五", "", ""];

export default function HeatCalendar({ cells }: { cells: CalendarCell[] }) {
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
                      : `${cell.date} · ${cell.count} 个词`
                  }
                  className="w-[12px] h-[12px] rounded-xs"
                  style={{
                    background: cell.future
                      ? "transparent"
                      : LEVEL_BG[level(cell.count)],
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

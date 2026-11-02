"use client";

/**
 * 多邻国式进度条：绿色填充 + 灰色轨道 + 闪光动画
 * 用于阅读页顶部的「今日阅读进度」
 */
export default function DuoProgress({
  value,
  max,
  label,
  hint,
}: {
  value: number;
  max: number;
  label?: string;
  hint?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const done = value >= max;

  return (
    <div className="duo-progress-wrap">
      <div className="flex items-center gap-3 mb-2">
        <div className="flex-1">
          {label && (
            <p className="text-[14px] font-bold text-ink mb-0.5">{label}</p>
          )}
          {hint && <p className="text-[12.5px] font-medium text-ink-faint">{hint}</p>}
        </div>
        {done && (
          <span className="duo-badge" style={{ background: "var(--duo-green-soft)", color: "var(--duo-green-dark)" }}>
            ✓ 完成
          </span>
        )}
      </div>

      <div className="duo-progress">
        <div
          className={`duo-progress-fill ${done ? "duo-progress-fill-done" : ""}`}
          style={{ width: `${pct}%` }}
        >
          {pct > 12 && <span className="duo-progress-shine" />}
        </div>
        <span className="duo-progress-flag">🚩</span>
      </div>

      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[12px] font-bold text-ink-faint">
          {value.toLocaleString()} / {max.toLocaleString()} 词
        </span>
        <span className="text-[12px] font-bold" style={{ color: done ? "var(--duo-green-dark)" : "var(--duo-blue-dark)" }}>
          {pct}%
        </span>
      </div>
    </div>
  );
}

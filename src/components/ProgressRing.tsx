/**
 * 小圆环进度（P56）：取代又长又黑的横向进度条。18–24px，一眼看出完成了多少。
 * 轨道是淡色细线，进度是主色（墨绿）；中间不放文字，数字由旁边的文字说明。
 */
export default function ProgressRing({
  ratio,
  size = 20,
  label,
}: {
  /** 0–1 */
  ratio: number;
  size?: number;
  label?: string;
}) {
  const r = 8;
  const c = 2 * Math.PI * r;
  const v = Math.min(Math.max(Number.isFinite(ratio) ? ratio : 0, 0), 1);
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-label={label ?? "进度"}
      style={{ flexShrink: 0, transform: "rotate(-90deg)" }}
    >
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--rf-border)" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke="var(--rf-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
        style={{ transition: "stroke-dashoffset 300ms ease" }}
      />
    </svg>
  );
}

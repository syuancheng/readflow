/**
 * ReadFlow 品牌 logo：三行「文字」流成一道波浪（Read → Flow）。
 * 徽章沿用全站的多邻国式立体按钮（绿色 + 底部深色边）。
 */
export default function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center rounded-xl shrink-0"
      style={{
        width: size,
        height: size,
        background: "var(--duo-green)",
        borderBottom: `${Math.max(2, Math.round(size / 16))}px solid var(--duo-green-dark)`,
      }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6} fill="none">
        <g stroke="#fff" strokeWidth="2.3" strokeLinecap="round">
          <path d="M5 7.4h14" />
          <path d="M5 12.1h8.4" />
          <path d="M5 17.2c2 0 2-2.6 4-2.6s2 2.6 4 2.6 2-2.6 4-2.6" />
        </g>
      </svg>
    </span>
  );
}

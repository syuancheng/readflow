/**
 * ReadFlow 品牌 logo：三行「文字」流成一道波浪（Read → Flow）。
 * 徽章是全站唯一常驻的品牌绿（--rf-brand），界面其余地方都是中性色。
 */
export default function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center rounded-xl shrink-0"
      style={{
        width: size,
        height: size,
        // 品牌绿只在 Logo 里出现（P52）；界面其余地方是中性的
        background: "var(--rf-brand)",
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

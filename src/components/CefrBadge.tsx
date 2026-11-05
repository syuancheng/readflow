/**
 * CEFR 难度徽章（服务端组件，无 JS）。
 *
 * 对齐 Readlang 的做法：级别是导入时服务端算好的，前端只负责展示，
 * 并且措辞必须承认「粗估」—— CEFR 是能力框架，不是官方文本评级。
 *
 * 悬停 / 键盘聚焦展开明细：各档词汇占比、句法统计、置信度、已知偏差。
 * 不用 click 是因为列表里整行都是一个 Link，嵌套可点击元素会互相打架；
 * 纯 CSS hover 既没有这个问题，也不需要把组件变成客户端组件。
 *
 * 内部一律用 span（display 由 CSS 控制）：阅读页把徽章放在 <p> 里，
 * <div> 嵌 <p> 是非法 HTML，span 最安全。
 */
import {
  CONFIDENCE_LABEL,
  VOCAB_BANDS,
  adjacentOfScore,
  type CefrDetail,
  type CefrLevel,
  type VocabBandKey,
} from "@/lib/cefr";

type Props = {
  level: CefrLevel | null;
  score: number | null;
  detail: CefrDetail | null;
};

const LEVEL_STYLE: Record<CefrLevel, { bg: string; fg: string }> = {
  A1: { bg: "var(--duo-green-soft)", fg: "var(--duo-green-dark)" },
  A2: { bg: "var(--duo-green-soft)", fg: "var(--duo-green-dark)" },
  B1: { bg: "var(--duo-blue-soft)", fg: "var(--duo-blue-dark)" },
  B2: { bg: "var(--duo-orange-soft)", fg: "var(--duo-orange-dark)" },
  C1: { bg: "var(--duo-purple-soft)", fg: "var(--duo-purple-dark)" },
  C2: { bg: "var(--duo-red-soft)", fg: "var(--duo-red)" },
};

const BAND_COLOR: Record<VocabBandKey, string> = {
  core: "var(--duo-green)",
  mid: "var(--duo-blue)",
  advanced: "var(--duo-purple)",
};

export default function CefrBadge({ level, score, detail }: Props) {
  // 没算出难度（词典缺失 / 非英文 / 太短）就完全不占位，别显示一个空的「?」
  if (!level) return null;

  const style = LEVEL_STYLE[level] ?? LEVEL_STYLE.B1;
  const adjacent = score === null ? null : adjacentOfScore(score);
  const confidence = detail?.confidence ?? "low";
  const bands = detail?.vocabulary?.bandRatios;
  const complexity = detail?.complexity;
  const extraCaveats = detail?.caveats?.slice(1) ?? [];

  return (
    <span
      className="cefr-wrap"
      tabIndex={0}
      aria-label={`难度粗略估计为 ${level}，置信度${CONFIDENCE_LABEL[confidence]}`}
    >
      <span className="duo-badge cefr-badge" style={{ background: style.bg, color: style.fg }}>
        难度 {level}
      </span>

      <span className="cefr-pop">
        <span className="cefr-pop-head">
          <strong>难度粗估 · {level}</strong>
          <span>{score === null ? "—" : `${score} / 100 分`}</span>
        </span>
        <span className="cefr-pop-note">
          基于词汇难度与句子复杂度的粗略估计，表示「读起来大概需要的水平」，不是 CEFR 官方评级。
        </span>
        {adjacent && (
          <span className="cefr-pop-line">分数贴近级别边界，实际也可能落在 {adjacent}。</span>
        )}

        {bands && (
          <span className="cefr-bands">
            <span className="cefr-bands-title">词汇分档（按词次占比）</span>
            {VOCAB_BANDS.map((band) => {
              const ratio = bands[band.key] ?? 0;
              const n = Math.round(ratio * 100);
              return (
                <span className="cefr-band" key={band.key}>
                  <span className="cefr-band-label">
                    {band.label} <em>{band.hint}</em>
                  </span>
                  <span className="cefr-bar">
                    <i style={{ width: `${n}%`, background: BAND_COLOR[band.key] }} />
                  </span>
                  <span className="cefr-band-num">{n}%</span>
                </span>
              );
            })}
          </span>
        )}

        {complexity && (
          <span className="cefr-pop-line">
            平均句长 {complexity.avgSentenceLength} 词 · 超长句{" "}
            {Math.round(complexity.longSentenceRatio * 100)}% · 共 {detail?.sentenceCount ?? "—"} 句
          </span>
        )}
        <span className="cefr-pop-line">置信度：{CONFIDENCE_LABEL[confidence]}</span>
        {extraCaveats.map((c) => (
          <span className="cefr-pop-caveat" key={c}>
            · {c}
          </span>
        ))}
      </span>
    </span>
  );
}

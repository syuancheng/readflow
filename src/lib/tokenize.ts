export type Token = {
  text: string;
  start: number;
  end: number;
  word: boolean;
};

/** 锚点上下文窗口：取前后各多少字符作为 prefix / suffix */
export const CONTEXT_WINDOW = 40;

/**
 * 确定性分词。
 *
 * 这里刻意不用 Intl.Segmenter：它的分词结果依赖运行环境的 ICU 版本，
 * 服务端（Node）和客户端（Chrome）可能给出不同切分，导致 React hydration 失败。
 * 长文本尤其明显——同一段文字两边切得不一样，整棵树会被丢弃重建。
 *
 * 用纯正则保证「同一输入永远同一输出」，两边渲染必然一致。
 * 代价是没有词典分词，中文按字切；等做中文时换成跨环境一致的纯 JS 分词器。
 */
const TOKEN_RE =
  /[A-Za-z0-9\u00C0-\u024F]+(?:['’\-][A-Za-z0-9\u00C0-\u024F]+)*|[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ text: text.slice(last, m.index), start: last, end: m.index, word: false });
    }
    out.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
      word: true,
    });
    last = m.index + m[0].length;
  }

  if (last < text.length) {
    out.push({ text: text.slice(last), start: last, end: text.length, word: false });
  }

  return out;
}

/**
 * 生成位置锚点。offset 只当快速路径，真正能扛住文本变化的是 quote + 前后文。
 * 见 W3C Web Annotation 的 TextQuoteSelector / TextPositionSelector 模型。
 */
export function buildAnchor(paragraph: string, start: number, end: number) {
  const s = Math.max(0, Math.min(start, paragraph.length));
  const e = Math.max(s, Math.min(end, paragraph.length));
  return {
    start: s,
    end: e,
    quote: paragraph.slice(s, e),
    prefix: paragraph.slice(Math.max(0, s - CONTEXT_WINDOW), s),
    suffix: paragraph.slice(e, Math.min(paragraph.length, e + CONTEXT_WINDOW)),
  };
}

export type Anchor = ReturnType<typeof buildAnchor>;

/**
 * 用锚点把文本里的位置找回来。先信任 offset，对不上再用 quote + 前后文搜。
 * 返回 null 表示这段文字已经不在了（文本被改过），调用方应降级处理而不是乱跳。
 */
export function resolveAnchor(paragraph: string, a: Anchor): { start: number; end: number } | null {
  if (paragraph.slice(a.start, a.end) === a.quote) {
    return { start: a.start, end: a.end };
  }

  const needle = `${a.prefix}${a.quote}${a.suffix}`;
  const at = paragraph.indexOf(needle);
  if (at >= 0) {
    const start = at + a.prefix.length;
    return { start, end: start + a.quote.length };
  }

  // 前后文也可能被改动过，退一步只按 quote 搜；唯一命中才认
  const first = paragraph.indexOf(a.quote);
  if (first >= 0 && paragraph.indexOf(a.quote, first + 1) === -1) {
    return { start: first, end: first + a.quote.length };
  }

  return null;
}

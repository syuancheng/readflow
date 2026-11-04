/**
 * 按情况截取 AI 释义的上下文（对齐并小幅超越 Readlang 的句子级设计）：
 *
 * - 单词 / 短语（未覆盖整句）：前文、后文都截到所在句子的边界
 *   —— 即 Readlang 的「整句上下文」，保证句子主语完整，不被锚点窗口截断
 * - 划了完整一句（或多句）：选区本身已是完整句子，前文/后文各给相邻一句，补语境
 *
 * 句子切分用 Intl.Segmenter（正确处理 Mr. / e.g. / 引号等，替代手写正则）。
 * 仅在浏览器事件回调中调用（点词/划选时），不参与 SSR 渲染，无 hydration 风险。
 */

type Span = { start: number; end: number };

/** 段落按句子切分，返回每句的字符区间。环境不支持时退化为简单正则。 */
export function splitSentences(text: string): Span[] {
  if (text.length === 0) return [{ start: 0, end: 0 }];

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    return [...seg.segment(text)].map((s) => ({
      start: s.index,
      end: s.index + s.segment.length,
    }));
  }

  // 兜底：老环境没有 Segmenter，用朴素句末标点切分（够用，但不识别缩写）
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(/[^\n]+/g)) {
    const lineStart = m.index!;
    let s = lineStart;
    for (const sm of m[0].matchAll(/[^.!?…]*[.!?…]+["')\]]*\s*/g)) {
      const segStart = lineStart + sm.index!;
      if (segStart + sm[0].length > s) {
        out.push({ start: s, end: segStart + sm[0].length });
        s = segStart + sm[0].length;
      }
    }
    if (s < lineStart + m[0].length) out.push({ start: s, end: lineStart + m[0].length });
    last = lineStart + m[0].length;
  }
  return out.length ? out : [{ start: 0, end: text.length }];
}

/**
 * 计算发给 AI 的前文/后文。
 * @param paragraph  选区所在段落的完整文本
 * @param start/end  选区在段落内的字符区间
 */
export function aiContextOf(paragraph: string, start: number, end: number): { prefix: string; suffix: string } {
  const s = Math.max(0, Math.min(start, paragraph.length));
  const e = Math.max(s, Math.min(end, paragraph.length));

  const sentences = splitSentences(paragraph);
  // 与选区重叠的句子集合 [s0, s1]
  let s0 = -1;
  let s1 = -1;
  sentences.forEach((sn, i) => {
    if (sn.end > s && sn.start < e) {
      if (s0 < 0) s0 = i;
      s1 = i;
    }
  });
  if (s0 < 0) {
    // 选区落在句子间隙（理论上不会）：退化为段落级
    return { prefix: paragraph.slice(0, s), suffix: paragraph.slice(e) };
  }

  const coreStart = sentences[s0].start;
  const coreEnd = sentences[s1].end;

  // 选区基本覆盖所在句（≥80%）：视为「划了整句」→ 前后取相邻句补语境
  const selLen = e - s;
  const coreLen = coreEnd - coreStart;
  if (selLen >= coreLen * 0.8 && coreLen > 0) {
    const prevStart = s0 > 0 ? sentences[s0 - 1].start : coreStart;
    const nextEnd = s1 + 1 < sentences.length ? sentences[s1 + 1].end : coreEnd;
    return {
      prefix: paragraph.slice(prevStart, s),
      suffix: paragraph.slice(e, nextEnd),
    };
  }

  // 单词/短语：前后文截到句子边界（整句上下文，对齐 Readlang）
  return {
    prefix: paragraph.slice(coreStart, s),
    suffix: paragraph.slice(e, coreEnd),
  };
}

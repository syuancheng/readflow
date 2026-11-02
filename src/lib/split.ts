/**
 * 文本切段。段落是后续一切的基础：
 * 渲染单元、虚拟滚动单元、以及位置锚定的坐标原点。
 */
export function splitParagraphs(raw: string): string[] {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];

  const byBlank = text.split(/\n\s*\n+/).map(normalize).filter(Boolean);
  const byLine = text.split(/\n+/).map(normalize).filter(Boolean);

  // 空行分段不奏效（单换行的小说/字幕文本）时退回按行分段
  if (byBlank.length <= 1 && byLine.length > 3) return byLine;
  return byBlank;
}

function normalize(p: string): string {
  return p.replace(/[ \t]+/g, " ").replace(/\n/g, " ").trim();
}

/** 粗略词数，用于列表展示。英文按空白计，CJK 按字计。 */
export function countWords(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) ?? []).length;
  const latin = (text.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, " ").match(/[A-Za-z0-9'’-]+/g) ?? []).length;
  return cjk + latin;
}

/**
 * 从段落里截出包含 [start, end) 的那一整句，并给出目标词在句内的偏移。
 *
 * 卡片正面要放「原句」，而 contexts 只存了段内偏移和前后各 40 字符——
 * 40 字符常常不够一整句（长句会被截断），所以这里回到段落原文按句读边界扩。
 * 返回的 offset 是给 cardgen 做「把目标词单独包起来 / 替换成空格」用的。
 */
export function sentenceAround(
  text: string,
  start: number,
  end: number,
): { sentence: string; offset: number } {
  const s0 = Math.max(0, Math.min(start, text.length));
  const e0 = Math.max(s0, Math.min(end, text.length));

  let s = s0;
  while (s > 0 && !/[.!?。！？]/.test(text[s - 1])) s--;
  while (s < s0 && /\s/.test(text[s])) s++;

  let e = e0;
  while (e < text.length && !/[.!?。！？]/.test(text[e])) e++;
  if (e < text.length) e++;

  const raw = text.slice(s, e);
  const lead = raw.length - raw.trimStart().length;
  const sentence = raw.trim();

  return { sentence, offset: Math.max(0, s0 - s - lead) };
}

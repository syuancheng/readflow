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

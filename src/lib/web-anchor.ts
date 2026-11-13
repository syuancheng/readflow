/**
 * 网页坐标 → 阅读页坐标的换算（P31）。
 *
 * 浏览器插件拿到的坐标是「块元素文本里的字符偏移」，而阅读页里
 * `contexts.start/end` 的基准是 `paragraphs.content`（见 src/db/schema.ts 注释）。
 * 两边文本几乎不可能逐字相同：网页里有换行、连续空格、`&nbsp;`，
 * 导入时的正文块已经过清洗。所以不能直接照搬偏移，必须先在段落里找到
 * 这块文字，再把选区换算成段落内坐标。
 *
 * 全部是纯函数、无 IO、不依赖浏览器 API，可在 Node 里直接单测。
 */

/** 把各种空白（含 `&nbsp;`、换行、制表符）压成一个空格，并去掉首尾空白 */
export function normalizeBlockText(s: string): string {
  return String(s ?? "")
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

/** 去掉 #fragment，保留 query */
export function stripHash(url: string): string {
  const s = String(url ?? "");
  const at = s.indexOf("#");
  return at >= 0 ? s.slice(0, at) : s;
}

/**
 * 归一化文本 + 索引回映：norm[i] 来自原文的 map[i]，
 * map[norm.length] 指向原文末尾（用于取区间右端）。
 */
function normalizeWithMap(content: string): { norm: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (/[\s\u00a0]/.test(ch)) {
      const runStart = i;
      while (i < content.length && /[\s\u00a0]/.test(content[i])) i++;
      // 首尾空白在归一化后会被 trim 掉，这里先记录，最后统一裁
      chars.push(" ");
      map.push(runStart);
    } else {
      chars.push(ch);
      map.push(i);
      i++;
    }
  }
  map.push(content.length);

  // trim：去掉首尾那个「空格」以及它的映射
  let start = 0;
  let end = chars.length;
  while (start < end && chars[start] === " ") start++;
  while (end > start && chars[end - 1] === " ") end--;
  return { norm: chars.slice(start, end).join(""), map: map.slice(start, end + 1) };
}

/** 前文贴合度：原文里 quote 之前那 30 个字符与块内前文的最长公共后缀 */
function prefixScore(content: string, at: number, prefixText: string): number {
  const before = normalizeBlockText(content.slice(Math.max(0, at - 60), at));
  const want = normalizeBlockText(prefixText).slice(-30);
  let n = 0;
  while (
    n < before.length &&
    n < want.length &&
    before[before.length - 1 - n] === want[want.length - 1 - n]
  ) {
    n++;
  }
  return n;
}

/** 在段落原文里找出 quote 的全部位置（先直接搜，空白有差异时走归一化回映） */
function findQuotePositions(
  content: string,
  quote: string,
  prefixText: string,
): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  const MAX = 60;

  for (let at = content.indexOf(quote); at !== -1; at = content.indexOf(quote, at + 1)) {
    found.push({ start: at, end: at + quote.length });
    if (found.length >= MAX) return found;
  }
  if (found.length > 0) return found;

  // 网页文本与段落文本的空白不一致（换行 / 连续空格 / nbsp）：在归一化空间里定位，
  // 再映射回原文下标。返回的是**段落原文**里的区间——调用方随后用
  // buildAnchor(paragraph.content, …) 生成 quote，坐标必须落在原文上才画得对。
  const { norm, map } = normalizeWithMap(content);
  const nq = normalizeBlockText(quote);
  if (!nq) return found;
  for (let at = norm.indexOf(nq); at !== -1; at = norm.indexOf(nq, at + 1)) {
    const start = map[at];
    const end = map[at + nq.length] ?? content.length;
    // 归一化后必须与 quote 完全一致，否则说明定位偏了，宁可放弃也不画错位置
    if (normalizeBlockText(content.slice(start, end)) === nq) {
      found.push({ start, end });
      if (found.length >= MAX) break;
    }
  }
  void prefixText;
  return found;
}

/** 相似度只看词：小写、去掉标点，按空白切开 */
function tokensOf(s: string): string[] {
  return normalizeBlockText(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'’-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 段落和网页块的相似度（0–1）：两边共有的词数 ÷ 较长一边的词数。
 * 用「较长一边」做分母，是为了让很短的段落（例如标题 "Skills"）即使整个被块包含，
 * 得分也很低——它只占块的一小部分，不可能是同一段。
 */
export function blockSimilarity(a: string, b: string): number {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const count = new Map<string, number>();
  for (const t of ta) count.set(t, (count.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of tb) {
    const n = count.get(t) ?? 0;
    if (n > 0) {
      common++;
      count.set(t, n - 1);
    }
  }
  return common / Math.max(ta.length, tb.length);
}

/** 不完全相同的段落，至少要这么像才算「同一段」（网页多了脚注、少了个标点这类差异） */
export const MIN_BLOCK_SIMILARITY = 0.8;

/** 原文下标 → 归一化文本里的下标（归一化规则同 normalizeBlockText） */
function normalizedOffset(raw: string, at: number): number {
  // 末尾补一个非空白占位符，防止 trim 吃掉选区前的那个空格
  return normalizeBlockText(raw.slice(0, at) + "\u0001").length - 1;
}

/**
 * 在已导入文章的段落里找到这个块，并把选区换算成段落内坐标。
 *
 * 候选段落按可信度分四档，依次尝试，先在哪一档找到选区就用哪一档：
 * 1. 归一化后与块完全相等；
 * 2. 与块高度相似（`blockSimilarity` ≥ MIN_BLOCK_SIMILARITY，例如网页多了脚注 [1]），相似度高的先试；
 * 3. 段落包含整个块（网页把一段拆成了几个元素）；
 * 4. 块包含整个段落（网页把几段塞进了一个元素），**并且选区落在这段在块里的位置上**。
 *    只看「包含」不够：标题 "Skills" 也被正文块包含，点正文里的 Skills 会被画到标题上
 *    （P31 验收时复现过）。
 *
 * 选区在段落里出现多处时，取前文（选区前 30 字符）最贴合的一处。
 * 返回的坐标落在段落原文上，与选区一致（空白差异按归一化比较）；找不到返回 null，
 * 由调用方退回「网页摘录」。
 */
export function locateInParagraphs(
  paragraphs: { id: string; content: string }[],
  block: string,
  start: number,
  end: number,
): { paragraphId: string; start: number; end: number } | null {
  const quote = block.slice(start, end);
  if (!quote) return null;

  const normBlock = normalizeBlockText(block);
  if (!normBlock) return null;
  const quoteAt = normalizedOffset(block, start);
  const quoteLen = normalizeBlockText(quote).length;

  const exact: { id: string; content: string }[] = [];
  const similar: { p: { id: string; content: string }; score: number; order: number }[] = [];
  const containsBlock: { id: string; content: string }[] = [];
  const insideBlock: { p: { id: string; content: string }; len: number }[] = [];

  paragraphs.forEach((p, order) => {
    const normContent = normalizeBlockText(p.content);
    if (!normContent) return;
    if (normContent === normBlock) {
      exact.push(p);
      return;
    }
    const score = blockSimilarity(normContent, normBlock);
    if (score >= MIN_BLOCK_SIMILARITY) {
      similar.push({ p, score, order });
      return;
    }
    if (normContent.includes(normBlock)) {
      containsBlock.push(p);
      return;
    }
    // 第 4 档：这段在块里出现的某一处，必须盖住选区。
    // 另外排除「很短的段落」（标题、图注）：网页把几段合进一个元素时，合进去的正文段
    // 通常不会少于 5 个词；而标题被正文块包含、又恰好盖住选区，是最常见的误判来源。
    if (tokensOf(normContent).length < 5 && normContent.length < normBlock.length * 0.4) return;
    for (let at = normBlock.indexOf(normContent); at !== -1; at = normBlock.indexOf(normContent, at + 1)) {
      if (at <= quoteAt && quoteAt + quoteLen <= at + normContent.length) {
        insideBlock.push({ p, len: normContent.length });
        break;
      }
    }
  });
  similar.sort((a, b) => b.score - a.score || a.order - b.order);
  // 选区落在多段里（例如短标题和正文同时盖住了它）时，长的那段更可能是正文
  insideBlock.sort((a, b) => b.len - a.len);

  const tiers = [exact, similar.map((x) => x.p), containsBlock, insideBlock.map((x) => x.p)];
  const prefixText = block.slice(Math.max(0, start - 30), start);
  for (const tier of tiers) {
    for (const p of tier) {
      const positions = findQuotePositions(p.content, quote, prefixText);
      if (positions.length === 0) continue;
      // 多处出现：取前文最贴合的一处；分数相同取最靠前的
      let best = positions[0];
      let bestScore = prefixScore(p.content, best.start, prefixText);
      for (const pos of positions.slice(1)) {
        const sc = prefixScore(p.content, pos.start, prefixText);
        if (sc > bestScore) {
          best = pos;
          bestScore = sc;
        }
      }
      return { paragraphId: p.id, start: best.start, end: best.end };
    }
  }

  return null;
}

/** 每一部分都要按文本片段语法转义：`-` 和 `,` 在其中有特殊含义 */
function encodeFragmentPart(s: string): string {
  return encodeURIComponent(s)
    .replace(/-/g, "%2D")
    .replace(/,/g, "%2C");
}

function words(s: string): string[] {
  const t = s.trim();
  return t ? t.split(/\s+/) : [];
}

/**
 * 生成 Chrome 文本片段链接：`${url}#:~:text=prefix-,text,-suffix`
 *
 * prefix 取末尾最多 3 个词、suffix 取开头最多 3 个词；为空时省略对应部分及其分隔符。
 * 打开这个链接浏览器会滚动到那句话并高亮它 —— 词库「来源」在网页没被整篇导入时用。
 */
export function textFragmentUrl(
  sourceUrl: string,
  quote: string,
  prefix: string,
  suffix: string,
): string {
  const head = words(prefix).slice(-3).join(" ");
  const tail = words(suffix).slice(0, 3).join(" ");
  const text = encodeFragmentPart(quote);

  let frag = "";
  if (head) frag += `${encodeFragmentPart(head)}-,`;
  frag += text;
  if (tail) frag += `,-${encodeFragmentPart(tail)}`;

  return `${stripHash(sourceUrl)}#:~:text=${frag}`;
}

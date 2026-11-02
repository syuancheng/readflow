/**
 * 墨墨记忆卡（Markji）卡片生成。
 *
 * 这里的产出不是「文本」，是**一整段 Markji 专用语法**：换行、`---` 答案线、
 * 块级标签顶格都是语法的一部分，写错不会报错，只会静默渲染成乱码。
 * 所以每个模板都：① 只做确定性拼装（不调 AI）；② 生成后过一遍 lintCard()。
 *
 * 三种卡片对应 Readlang 的两个模式，外加一个它没有的类型：
 *   qa     看词猜义（Passive）  词 + 音标 + 原句  →  中文释义
 *   cloze  挖空填空（Active）   原句挖空 + 释义提示 →  原词
 *   choice 选择题（我们没有的）  原句挖空 + 4 选项  →  答案
 */

import { normalizePhonetic, normalizeTranslation } from "./text";

export type CardType = "qa" | "cloze" | "choice";
export const CARD_TYPES: { key: CardType; label: string; hint: string }[] = [
  { key: "qa", label: "看词猜义", hint: "词 + 音标 + 原句 → 释义（对应 Readlang Passive）" },
  { key: "cloze", label: "挖空填空", hint: "原句挖空 + 释义提示 → 猜原词（对应 Active）" },
  { key: "choice", label: "选择题", hint: "原句挖空 + 4 个同类词选项" },
];

export type CardInput = {
  /** 用户点到的词形，如 "rained" */
  word: string;
  /** 词典原形，如 "rain" */
  lemma: string;
  phonetic?: string | null;
  translation: string;
  /** 含目标词的整句 */
  sentence: string;
  /** 目标词在 sentence 中的起始下标 */
  offset: number;
  sourceTitle?: string | null;
  /** 选择题干扰项（不含正确答案） */
  distractors?: string[];
};

const GREY = "!888888";
const RED = "!e53935";
const BLUE = "!1cb0f6";

/**
 * 普通文字里的 `[` `]` 必须转义，否则会提前闭合外层标签。
 * ECDICT 的释义里就有这种字符（如 `[医] 库`），不转义直接毁卡。
 */
function esc(s: string): string {
  return s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** 压成一行：去掉真实换行、压缩连续空格，转义中括号 */
function oneLine(s: string): string {
  return esc(
    s
      .replace(/\r/g, "")
      .replace(/[\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim(),
  );
}

/** 释义按行拆开，每行做成一个列表项；顺带清掉不会被渲染的 Markdown 记号 */
function translationLines(translation: string): string[] {
  // ECDICT 用字面量 `\n` 分隔释义，先还原成真实换行再切
  return normalizeTranslation(translation)
    .split(/\n+/)
    .map((l) => oneLine(l).replace(/\*\*/g, "").replace(/`/g, ""))
    .filter(Boolean);
}

/** 把整句拆成「前 / 词 / 后」，用于把目标词单独包起来或替换成空格 */
function split(sentence: string, offset: number, len: number) {
  const s = Math.max(0, Math.min(offset, sentence.length));
  return {
    before: sentence.slice(0, s),
    word: sentence.slice(s, s + len),
    after: sentence.slice(s + len),
  };
}

function head(word: string, phonetic: string | null) {
  const lines = [`[P#H1,center#[T#B#${oneLine(word)}]]`];
  if (phonetic) lines.push(`[P#center#[T#${GREY}#/${normalizePhonetic(phonetic)}/]]`);
  return lines;
}

function sourceLine(title?: string | null) {
  return title ? [`[P#center#[T#${GREY}#${oneLine(title)}]]`] : [];
}

function answerBody(translation: string) {
  const lines = translationLines(translation);
  if (lines.length === 0) return [`[P#L#${oneLine("（词典暂无释义）")}]`];
  return lines.map((l, i) =>
    i === 0 ? `[P#L#[T#B,${RED}#${l}]]` : `[P#L#[T#${GREY}#${l}]]`,
  );
}

/** 看词猜义：正面词 + 音标 + 原句（目标词标蓝），背面释义 */
export function buildQaCard(c: CardInput): string {
  const { before, word, after } = split(c.sentence, c.offset, c.word.length);

  const front = [
    ...head(c.word, c.phonetic ?? null),
    ...sourceLine(c.sourceTitle),
    "",
    `${esc(before)}[T#B,${BLUE}#${esc(word)}]${esc(after)}`,
  ];

  return [...front, "---", ...answerBody(c.translation), ""].join("\n");
}

/** 挖空填空：正面原句挖空 + 释义提示，背面揭示原词与完整释义 */
export function buildClozeCard(c: CardInput): string {
  const { before, word, after } = split(c.sentence, c.offset, c.word.length);
  const hint = translationLines(c.translation)[0] ?? "";

  const front = [
    "[P#H1,center#[T#B#填空]]",
    ...(hint ? [`[P#center#[T#${GREY}#提示：${hint}]]`] : []),
    ...sourceLine(c.sourceTitle),
    "",
    `${esc(before)}[F#1#${esc(word)}]${esc(after)}`,
  ];

  const back = [...head(c.word, c.phonetic ?? null), ...answerBody(c.translation)];

  return [...front, "---", ...back, ""].join("\n");
}

/** 选择题：原句挖空 + 正确词与同类干扰项，背面答案与释义 */
export function buildChoiceCard(c: CardInput): string {
  const { before, after } = split(c.sentence, c.offset, c.word.length);
  const blank = `${esc(before)}____${esc(after)}`;

  const others = (c.distractors ?? []).slice(0, 3);
  const total = others.length + 1;
  // 正确答案不一定排第一，避免靠位置蒙
  const correctAt = hashString(c.word + c.sentence) % total;

  const ordered: string[] = [];
  let oi = 0;
  for (let i = 0; i < total; i++) ordered.push(i === correctAt ? c.word : others[oi++]);

  const optionLines = ordered.map((o, i) => (i === correctAt ? `* ${esc(o)}` : `- ${esc(o)}`));

  const front = [
    `[P#L#[T#${GREY}#选一个能填进空格的词]]`,
    "",
    blank,
    "[Choice##",
    ...optionLines,
    "]",
  ];

  const back = [`[P#L#[T#B,${RED}#${esc(c.word)}]]`, ...answerBody(c.translation)];

  return [...front, "---", ...back, ""].join("\n");
}

export function buildCard(type: CardType, c: CardInput): string {
  if (type === "qa") return buildQaCard(c);
  if (type === "cloze") return buildClozeCard(c);
  return buildChoiceCard(c);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * 离线自检。`markji.py lint` 是更严格的那一关，这里是服务端发请求前的最后一道闸：
 * 能拦住最常见的三类毁卡原因（缺答案线、标签不闭合、Markdown 记号漏进来）。
 */
export function lintCard(content: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const lines = content.split("\n");

  if (!lines.some((l) => l.trim() === "---")) problems.push("缺少答案线 ---");
  if (lines.filter((l) => l.trim() === "---").length > 1) problems.push("答案线多于一条");

  // 方括号配对（忽略转义）
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "[" && content[i - 1] !== "\\") depth++;
    else if (ch === "]" && content[i - 1] !== "\\") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) problems.push("方括号不配对");

  if (content.includes("**")) problems.push("残留 Markdown 加粗 **");
  if (content.includes("```")) problems.push("残留代码块围栏");
  if (/<[a-zA-Z/][^>]*>/.test(content)) problems.push("残留 HTML 标签");

  // 块级标签必须顶格
  for (const l of lines) {
    const t = l.trimStart();
    if (t !== l && /^\[(P|Choice|Pic|E)#/.test(t)) {
      problems.push(`块级标签未顶格：${t.slice(0, 20)}`);
      break;
    }
  }

  return { ok: problems.length === 0, problems };
}

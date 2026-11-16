/**
 * CardSpec：AI 输出的卡片结构（P33 spec §4）。
 * 纯函数模块：只做类型定义与白名单解析，不碰数据库、不碰网络。
 * 单测编译走 CommonJS，只用相对路径 import。
 */

export type CardKind =
  | "context_meaning" | "word_completion" | "paraphrase_fill" | "sentence_understanding"
  | "true_false_ng" | "reference" | "collocation" | "listen_fill" | "listen_choose"
  | "layered_cloze" | "paragraph_cloze" | "custom"
  // P35 使用类：用句子学词、练开口（背面给参考说法，自己对照）
  | "back_translate" | "situation_say" | "rephrase" | "usage";

const KINDS: readonly CardKind[] = [
  "context_meaning", "word_completion", "paraphrase_fill", "sentence_understanding",
  "true_false_ng", "reference", "collocation", "listen_fill", "listen_choose",
  "layered_cloze", "paragraph_cloze", "custom",
  "back_translate", "situation_say", "rephrase", "usage",
];

/** P35 使用类题型（回译、情景说一句、换个说法、搭配与用法）；其余都是认识类 */
export const PRODUCTIVE_KINDS: ReadonlySet<CardKind> = new Set<CardKind>([
  "back_translate", "situation_say", "rephrase", "usage",
]);

export function isProductive(kind: string): boolean {
  return PRODUCTIVE_KINDS.has(kind as CardKind);
}

/**
 * 一组最多保留几张（P35 spec §2.2）。张数由 AI 决定，这只是挡住异常输出的保险，
 * 不是产品规则，提示词里不提这个数。
 */
export const CARDS_SAFETY_MAX = 8;

export type SentenceMark = {
  start: number;
  end: number;
  as: "highlight" | "blank" | "prefix";
  /** prefix：只露前 keep 个字母 */
  keep?: number;
};

export type Block =
  | { t: "sentence"; source: "original" | "paraphrase"; text: string; mark?: SentenceMark }
  | { t: "instruction"; text: string }
  | { t: "choice"; multi?: boolean; options: { text: string; correct: boolean }[] }
  | { t: "fill"; answer: string; hint?: string }
  | { t: "audio"; of: "word" | "sentence"; text: string }
  | { t: "text"; text: string; emphasis?: string[] };

export type CardSpec = {
  kind: CardKind;
  /** kind = custom 时的题型名（≤6 个字），系统配上通用 emoji ✳️ */
  customLabel?: string;
  /** 例如「托福 · 词汇题」，由系统按学生档案里的考试目标校正 */
  examStyle?: string | null;
  /** 这张卡考的是什么（给人看的，≤30 个字），不出现在卡面上 */
  target: string;
  front: Block[];
  /** 可选的提示层（PRD「分层提示」） */
  hints?: Block[];
  back: {
    answer: Block[];
    explanation?: Block[];
    sentenceMeaning?: string;
    structure?: string;
    example?: { en: string; zh: string };
    audio?: ("word" | "sentence")[];
  };
};

export type CardGenResult = { cards: CardSpec[] };

/** 解析结果：ok=false 时 reason 是给人看的中文原因 */
export type ParseResult =
  | { ok: true; cards: CardSpec[]; /** 超过保险上限被丢掉的张数 */ dropped?: number }
  | { ok: false; reason: string };

// ---------- 白名单解析：未知字段丢弃，类型不对就判失败 ----------

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseMark(v: unknown): SentenceMark | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (!isNum(o.start) || !isNum(o.end)) return undefined;
  const as = o.as === "highlight" || o.as === "blank" || o.as === "prefix" ? o.as : null;
  if (!as) return undefined;
  const mark: SentenceMark = { start: Math.floor(o.start as number), end: Math.floor(o.end as number), as };
  if (isNum(o.keep)) mark.keep = Math.max(1, Math.floor(o.keep));
  return mark;
}

function parseBlock(v: unknown): Block | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case "sentence": {
      if (!isStr(o.text)) return null;
      const source = o.source === "original" || o.source === "paraphrase" ? o.source : null;
      if (!source) return null;
      const mark = o.mark === undefined ? undefined : parseMark(o.mark);
      return { t: "sentence", source, text: o.text, ...(mark ? { mark } : {}) };
    }
    case "instruction":
      return isStr(o.text) ? { t: "instruction", text: o.text } : null;
    case "choice": {
      if (!Array.isArray(o.options) || o.options.length === 0) return null;
      const options: { text: string; correct: boolean }[] = [];
      for (const opt of o.options) {
        if (!opt || typeof opt !== "object") return null;
        const oo = opt as Record<string, unknown>;
        if (!isStr(oo.text) || typeof oo.correct !== "boolean") return null;
        options.push({ text: oo.text, correct: oo.correct });
      }
      const multi = o.multi === true ? true : undefined;
      return { t: "choice", options, ...(multi ? { multi } : {}) };
    }
    case "fill": {
      if (!isStr(o.answer)) return null;
      const hint = isStr(o.hint) ? o.hint : undefined;
      return { t: "fill", answer: o.answer, ...(hint ? { hint } : {}) };
    }
    case "audio": {
      if ((o.of !== "word" && o.of !== "sentence") || !isStr(o.text)) return null;
      return { t: "audio", of: o.of, text: o.text };
    }
    case "text": {
      if (!isStr(o.text)) return null;
      let emphasis: string[] | undefined;
      if (Array.isArray(o.emphasis)) {
        const parts = o.emphasis.filter(isStr);
        if (parts.length > 0) emphasis = parts;
      }
      return { t: "text", text: o.text, ...(emphasis ? { emphasis } : {}) };
    }
    default:
      return null;
  }
}

function parseBlocks(v: unknown): Block[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: Block[] = [];
  for (const item of v) {
    const b = parseBlock(item);
    if (!b) return null;
    out.push(b);
  }
  return out;
}

function parseCard(v: unknown): CardSpec | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const kind = KINDS.find((k) => k === o.kind);
  if (!kind) return null;
  if (!isStr(o.target)) return null;

  const front = parseBlocks(o.front);
  if (!front) return null;

  let hints: Block[] | undefined;
  if (o.hints !== undefined && o.hints !== null) {
    const h = parseBlocks(o.hints);
    if (!h) return null;
    hints = h;
  }

  const backRaw = o.back;
  if (!backRaw || typeof backRaw !== "object") return null;
  const b = backRaw as Record<string, unknown>;
  const answer = parseBlocks(b.answer);
  if (!answer) return null;

  let explanation: Block[] | undefined;
  if (b.explanation !== undefined && b.explanation !== null) {
    const e = parseBlocks(b.explanation);
    if (!e) return null;
    explanation = e;
  }

  let example: { en: string; zh: string } | undefined;
  if (b.example !== undefined && b.example !== null) {
    const ex = b.example as Record<string, unknown>;
    if (!isStr(ex.en) || !isStr(ex.zh)) return null;
    example = { en: ex.en, zh: ex.zh };
  }

  let audio: ("word" | "sentence")[] | undefined;
  if (Array.isArray(b.audio)) {
    const parts: ("word" | "sentence")[] = [];
    for (const a of b.audio) {
      if (a !== "word" && a !== "sentence") return null;
      parts.push(a);
    }
    if (parts.length > 0) audio = parts;
  }

  const spec: CardSpec = {
    kind,
    target: o.target.slice(0, 30),
    front,
    ...(isStr(o.customLabel) ? { customLabel: o.customLabel.slice(0, 6) } : {}),
    ...(typeof o.examStyle === "string" ? { examStyle: o.examStyle || null } : {}),
    ...(hints ? { hints } : {}),
    back: {
      answer,
      ...(explanation ? { explanation } : {}),
      ...(isStr(b.sentenceMeaning) ? { sentenceMeaning: b.sentenceMeaning } : {}),
      ...(isStr(b.structure) ? { structure: b.structure } : {}),
      ...(example ? { example } : {}),
      ...(audio ? { audio } : {}),
    },
  };
  return spec;
}

/**
 * 宽松地取出模型输出里的 JSON 对象：先原样解析；不行就去掉 ```json 代码块围栏，
 * 或截取第一个「{」到最后一个「}」之间的部分再解析（有的模型会在 JSON 前后加一句话）。
 * 都不行返回 undefined。纯函数，导出供单测与选择题复核共用。
 */
export function parseJsonLoose(raw: string): unknown {
  const tryParse = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  const text = raw.trim();
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) {
    const v = tryParse(fenced);
    if (v !== undefined) return v;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(text.slice(start, end + 1));
  return undefined;
}

/**
 * 解析模型的出题输出。要求顶层是 `{"cards": [...]}`，至少 1 张；张数由 AI 决定（P35 PRD F2），
 * 超过保险上限 CARDS_SAFETY_MAX 时只保留前面的。
 * 未知字段丢弃；任何必要字段类型不对 → 整体失败（按失败重出处理）。
 */
export function parseCardGen(raw: string): ParseResult {
  if (!raw.trim()) return { ok: false, reason: "模型返回了空内容" };
  const v = parseJsonLoose(raw);
  if (v === undefined) return { ok: false, reason: "模型没有返回合法的 JSON" };
  if (!v || typeof v !== "object") return { ok: false, reason: "模型返回的顶层不是对象" };
  const cardsRaw = (v as Record<string, unknown>).cards;
  if (!Array.isArray(cardsRaw) || cardsRaw.length === 0) {
    return { ok: false, reason: "模型没有返回任何卡片" };
  }
  const kept = cardsRaw.slice(0, CARDS_SAFETY_MAX);
  const cards: CardSpec[] = [];
  for (const item of kept) {
    const c = parseCard(item);
    if (!c) return { ok: false, reason: "卡片的字段类型不符合要求" };
    cards.push(c);
  }
  const dropped = cardsRaw.length - kept.length;
  return dropped > 0 ? { ok: true, cards, dropped } : { ok: true, cards };
}

/**
 * 卡片校验（P33 spec §5.2，PRD §5 的 11 条原则）。纯函数，逐条单测。
 * 校验失败 → 生成流程重出一次；仍失败 → 组级 failed（或选择题标记 needs_review）。
 */
import type { CardSpec, Block } from "./spec";
import { renderCardChecked } from "./render";
import type { Voice } from "./audio";

export type ValidateCtx = {
  /** 这条记录所在句子（buildAnchor 的 prefix + quote + suffix） */
  originalSentence: string;
  /** 目标词或短语 */
  quote: string;
  /** 这个词在这句里的中文意思（讲解「释义：」那一行，或词典第一个义项） */
  glossZh: string | null;
  /** 1800 或 4000（PRD Q7，用户已确认文档里的 4500 是错的） */
  charLimit: number;
  /** 来源标题（渲染进标签行，计入字数）；不传按空 */
  sourceTitle?: string;
  /** P35：要配句子音频时传音色（音频标签计入字数上限）；不传按不配 */
  audio?: Voice | null;
};

export type ValidateResult = { ok: true } | { ok: false; reasons: string[] };

/**
 * 收集一个块里所有用户可见文字（audio 块的 text 不显示，不计入泄露检查）。
 * 句子里被挖空 / 只露前缀的部分先遮掉，剩下的才是学生真正看得到的。
 */
function visibleText(blocks: Block[] | undefined): string {
  if (!blocks) return "";
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.t === "sentence") parts.push(maskedSentence(b));
    else if (b.t === "instruction" || b.t === "text") parts.push(b.text);
    else if (b.t === "fill") parts.push(b.hint ?? "");
    else if (b.t === "choice") parts.push(b.options.map((o) => o.text).join(" "));
  }
  return parts.join("\n");
}

function maskedSentence(b: Extract<Block, { t: "sentence" }>): string {
  const m = b.mark;
  if (!m || (m.as !== "blank" && m.as !== "prefix")) return b.text;
  if (m.start < 0 || m.end > b.text.length || m.start >= m.end) return b.text;
  const keep = m.as === "prefix" ? Math.min(m.keep ?? 0, m.end - m.start) : 0;
  return `${b.text.slice(0, m.start + keep)}＿${b.text.slice(m.end)}`;
}

/** 可见文字里是否出现目标词（大小写不敏感；单词额外认词形变化） */
function leaksQuote(text: string, quote: string): boolean {
  const q = quote.trim();
  if (!q) return false;
  if (text.toLowerCase().includes(q.toLowerCase())) return true;
  if (/^[A-Za-z'-]+$/.test(q)) {
    return (text.match(/[A-Za-z]+/g) ?? []).some((w) => sameWord(w, q));
  }
  return false;
}

/**
 * 一个词可能的词干集合：去掉常见屈折后缀，并补上英文常见的拼写变化
 * （running → run 双写辅音、making → make 吃掉 e、studies → study）。
 * 太宽会把答案遮死，太窄会把 running / run 当成不同的词；词干至少 3 个字母。
 */
function stemsOf(word: string): Set<string> {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  const out = new Set<string>([w]);
  const add = (base: string, suffix: string) => {
    if (base.length < 3) return;
    out.add(base);
    out.add(`${base}e`);
    if (/([^aeiou])\1$/.test(base)) out.add(base.slice(0, -1));
    if (suffix === "ies" || suffix === "ied") out.add(`${base}y`);
  };
  for (const suffix of ["ies", "ied", "ing", "est", "ed", "es", "er", "ly", "s"]) {
    if (w.endsWith(suffix) && w.length > suffix.length) add(w.slice(0, -suffix.length), suffix);
  }
  return out;
}

function sameWord(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^a-z]/g, "");
  const y = b.toLowerCase().replace(/[^a-z]/g, "");
  if (!x || !y) return false;
  if (x === y) return true;
  const sy = stemsOf(y);
  for (const stem of stemsOf(x)) if (sy.has(stem)) return true;
  return false;
}

/** 短语里的占位词不参与匹配（fall behind on sth → fall / behind / on） */
const PLACEHOLDER_WORDS = new Set(["sth", "sb", "something", "someone", "somebody", "one's", "oneself", "do", "doing"]);

/**
 * 句子里用上了目标词或短语（P35 §11.2 第 5 条）。
 * - 单词：同 leaksQuote（认屈折变化）。
 * - 短语：除第一个词外，每个词都要出现（认屈折变化）；第一个词常是不规则动词
 *   （fall → fell、go → went），所以只要求它认得出或首字母相同，宁松勿严。
 */
export function usesTarget(text: string, quote: string): boolean {
  const q = quote.trim();
  if (!q) return false;
  if (text.toLowerCase().includes(q.toLowerCase())) return true;
  const words = (q.match(/[A-Za-z']+/g) ?? []).filter((w) => !PLACEHOLDER_WORDS.has(w.toLowerCase()));
  if (words.length === 0) return false;
  const inText = (text.match(/[A-Za-z']+/g) ?? []).map((w) => w.toLowerCase());
  if (words.length === 1) return inText.some((w) => sameWord(w, words[0]));
  const [head, ...rest] = words;
  const headOk = inText.some((w) => sameWord(w, head) || w[0] === head[0].toLowerCase());
  return headOk && rest.every((r) => inText.some((w) => sameWord(w, r)));
}

/** 比较两句英文是否相同：忽略大小写、标点和多余空白 */
function sameSentence(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return n(a) !== "" && n(a) === n(b);
}

const englishSentences = (blocks: Block[] | undefined) =>
  (blocks ?? []).filter((b): b is Extract<Block, { t: "sentence" }> => b.t === "sentence");

const wordCount = (s: string) => (s.match(/[A-Za-z0-9'’-]+/g) ?? []).length;

/** 回译的原句最多几个词（P35 PRD F2：太长就换成情景说一句） */
export const BACK_TRANSLATE_MAX_WORDS = 35;
/** 情景说一句 / 搭配与用法：参考说法几句（P35 PRD F1） */
export const REFERENCE_MIN = 2;
export const REFERENCE_MAX = 3;

export function validateCard(spec: CardSpec, ctx: ValidateCtx): ValidateResult {
  const reasons: string[] = [];

  // ---------- 1. 以句子为本 ----------
  // 输出类卡的正面可以是中文（回译的中文意思、情景说一句的场景），背面必须有英文句子
  const frontHasSentence =
    spec.front.some((b) => b.t === "sentence") ||
    spec.front.some((b) => b.t === "audio" && b.of === "sentence") ||
    spec.front.some((b) => b.t === "text" && b.text.trim() !== "");
  if (!frontHasSentence) {
    reasons.push("正面必须有一个句子（中文场景、英文句或整句音频）");
  }
  const answerSentences = englishSentences(spec.back.answer);
  if (answerSentences.length === 0) {
    reasons.push("输出类卡的背面必须有英文参考说法");
  }

  // ---------- 2. 原句一字不改 ----------
  for (const b of spec.front) {
    if (b.t === "sentence" && b.source === "original") {
      if (!ctx.originalSentence.trim().includes(b.text.trim())) {
        reasons.push("原句必须和文章原文逐字一致");
      }
    }
  }
  for (const b of [...(spec.hints ?? []), ...spec.back.answer, ...(spec.back.explanation ?? [])]) {
    if (b.t === "sentence" && b.source === "original") {
      if (!ctx.originalSentence.trim().includes(b.text.trim())) {
        reasons.push("原句必须和文章原文逐字一致（提示层 / 背面也一样）");
      }
    }
  }

  // ---------- 3. 标记位置正确 ----------
  const blanksOf = (blocks: Block[] | undefined) =>
    (blocks ?? []).flatMap((b) => {
      if (b.t === "sentence" && b.mark) return [{ block: b, mark: b.mark }];
      return [];
    });
  for (const { block, mark } of [...blanksOf(spec.front), ...blanksOf(spec.hints)]) {
    if (mark.start < 0 || mark.end > block.text.length || mark.start >= mark.end) {
      reasons.push("标记区间必须落在句子范围内");
      continue;
    }
    const covered = block.text.slice(mark.start, mark.end).trim();
    if ((mark.as === "blank" || mark.as === "prefix") && covered && !sameWord(covered, ctx.quote)) {
      reasons.push("挖空盖住的部分必须是目标词或它的词形变化");
    }
  }

  // ---------- 4. 正面不泄露答案 ----------
  const frontText = visibleText(spec.front) + "\n" + visibleText(spec.hints);
  // 输出类卡练的就是「用这个词说话」：正面可以有目标词和整句中文，但不能出现背面的英文参考说法
  const frontPlain = frontText.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const leaked = answerSentences.some((b) => {
    const n = b.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return n.length > 0 && frontPlain.includes(n);
  });
  if (leaked) reasons.push("输出类卡的正面不能出现背面的英文参考说法");

  // ---------- 5. 不允许识别/填空类零件（不做语法游戏）----------
  const allForRecognition = [...spec.front, ...(spec.hints ?? []), ...spec.back.answer, ...(spec.back.explanation ?? [])];
  if (allForRecognition.some((b) => b.t === "choice")) {
    reasons.push("不允许选择题：卡必须让用户输出英文，不是做识别题");
  }
  if (allForRecognition.some((b) => b.t === "fill")) {
    reasons.push("不允许填空块：卡必须让用户自己说出或写出英文");
  }
  if (allForRecognition.some((b) => b.t === "sentence" && b.mark && (b.mark.as === "blank" || b.mark.as === "prefix"))) {
    reasons.push("不允许挖空：卡必须让用户输出完整表达");
  }

  // ---------- 6. 背面必须有英文答案 ----------
  if (!spec.back.answer || spec.back.answer.length === 0) {
    reasons.push("背面必须有答案");
  }

  // ---------- P35 使用类卡（§11.2） ----------
  if (spec.kind === "back_translate") {
    const original = answerSentences.find((b) => b.source === "original");
    if (!original) reasons.push("回译卡的背面必须是原句");
    else if (wordCount(original.text) > BACK_TRANSLATE_MAX_WORDS) {
      reasons.push(`回译的原句超过 ${BACK_TRANSLATE_MAX_WORDS} 个词，请改出情景说一句`);
    }
  }
  if (spec.kind === "situation_say" || spec.kind === "usage") {
    const n = answerSentences.length;
    if (n < REFERENCE_MIN || n > REFERENCE_MAX) {
      reasons.push(`参考说法要有 ${REFERENCE_MIN}～${REFERENCE_MAX} 句英文`);
    }
  }
  // 2026-11-16：建卡改为以句子为单位、考点由 AI 从句子里挑（优先用户问过的难点），
  // 校验器无法准确判断「有没有考到句子里的表达」，这条改由出题提示词约束，不再硬校验。
  if (spec.kind === "rephrase") {
    const shown = englishSentences(spec.front);
    if (shown.length === 0) reasons.push("换个说法的正面要有一句英文");
    if (shown.some((b) => usesTarget(b.text, ctx.quote))) {
      reasons.push("换个说法的正面句子不能已经用上目标词");
    }
    if (shown.some((f) => answerSentences.some((a) => sameSentence(f.text, a.text)))) {
      reasons.push("换个说法的答案不能和正面的句子一样");
    }
  }

  // ---------- 7. 语音 ----------
  const allBlocks = [...spec.front, ...(spec.hints ?? []), ...spec.back.answer, ...(spec.back.explanation ?? [])];
  // 背面配音由渲染器按音色自动加到每句英文上，不受任何听力开关控制（用户 2026-11-16 定稿）。
  // 正面如需「先听再说」，AI 可以放一句整句音频；这是出题自由，不再由开关决定是否允许。

  // ---------- 8~11：作用在 AI 文本和渲染结果上 ----------
  const aiTexts = [
    ...allBlocks.filter((b) => b.t !== "audio").map((b) => (b as { text: string }).text),
    ...allBlocks.flatMap((b) => (b.t === "text" && b.emphasis ? b.emphasis : [])),
    ...allBlocks.flatMap((b) => (b.t === "choice" ? b.options.map((o) => o.text) : [])),
    ...allBlocks.flatMap((b) => (b.t === "fill" ? [b.answer, b.hint ?? ""] : [])),
    spec.back.sentenceMeaning ?? "",
    spec.back.structure ?? "",
    spec.back.example ? `${spec.back.example.en}\n${spec.back.example.zh}` : "",
    spec.target,
    spec.customLabel ?? "",
  ].join("\n");
  if (/\[Pic#/.test(aiTexts)) reasons.push("卡片里不允许出现图片");
  if (/\[(T|P|F|E|Card)#|\[Choice|\[Audio/.test(aiTexts)) {
    reasons.push("题目内容里不允许出现墨墨标签语法");
  }
  if (/^---\s*$/m.test(aiTexts)) reasons.push("题目内容里不允许出现答案线");

  // 渲染后再自检一遍：标签配对、答案线条数、字数上限都在这里一次性查
  if (reasons.length === 0) {
    const rendered = renderCardChecked(
      spec,
      { sourceTitle: ctx.sourceTitle ?? "", audio: ctx.audio ?? null },
      { charLimit: ctx.charLimit },
    );
    if (!rendered.ok) reasons.push(...rendered.problems);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
